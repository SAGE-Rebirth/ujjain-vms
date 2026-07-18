"""
Central Command API (FastAPI).

Responsibilities:
  * Citizen booking ("BookMyShow" layer)   — /api/zones, /api/bookings
  * Admin / command centre                 — /api/admin/*
  * Opportunistic batch sync for checkpoint nodes — /api/sync/*

Design rule (brief Section 3): this server is an OPTIMISATION, not a dependency.
Checkpoints keep working when it is unreachable; they reconcile here when a link
appears. So /api/sync/* is deliberately batch-shaped (push logs, pull a snapshot),
mirroring how FASTag plazas settle after a cut-off cycle rather than per-vehicle.
"""
from __future__ import annotations

import base64
import hmac
import io
import json
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import hashlib

import httpx
import qrcode
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

# Make the shared package importable when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared import auth, tickets  # noqa: E402

import db  # noqa: E402
import mongo_sync  # noqa: E402  (cloud mirror — inert unless MONGO_URI is set)

STAFF_ROLES = ("commander", "dispatcher", "operator")
# Max active (booked/arrived) bookings per citizen phone per event date. The
# anti-tout cap (docs/AUDIT.md C13 — TTD precedent: 545 users → 14,449 tickets).
BOOKING_CAP_PER_PHONE = int(os.environ.get("BOOKING_CAP_PER_PHONE", "10"))
# Capacity unification (docs/AUDIT.md C4): never sell more passes than a zone can
# physically park, beyond a small governed overbook to cover no-shows. The ceiling
# is Σ(lot capacity) × ratio; slots still meter arrival *rate* per window on top.
OVERBOOK_RATIO = float(os.environ.get("OVERBOOK_RATIO", "1.15"))

app = FastAPI(title="Ujjain VMS — Central Command")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # prototype; lock down per-origin in production
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

VEHICLE_FOOTPRINT = {"2w": 1, "car": 1, "bus": 1, "emergency": 0}

# Hard validity past the slot's end. The signed `exp` lets a checkpoint reject a
# stale pass OFFLINE even with an empty cache (docs/DESIGN-v2.md §4); the softer
# per-slot arrival window is enforced separately at the node (ENFORCE_WINDOW).
TICKET_EXP_GRACE_HOURS = int(os.environ.get("TICKET_EXP_GRACE_HOURS", "6"))

def _load_dotenv() -> None:
    """Load KEY=VALUE pairs from a project-root .env into os.environ (no extra dep).
    Existing env vars win, so an explicit export still overrides the file."""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()

# Razorpay payment gateway. LIVE when both keys are present (env or .env); otherwise
# the server runs in MOCK mode — the same order→verify→book flow, but without
# contacting Razorpay — so the prototype demos end-to-end with no account.
# Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET to switch to real checkout.
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "").strip()
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "").strip()
RAZORPAY_LIVE = bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)
RAZORPAY_ORDERS_URL = "https://api.razorpay.com/v1/orders"


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")   # zone/slot/lot id shape
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")  # staff usernames (allow dots)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _valid_date(date: str) -> str:
    """Reject anything that is not a real YYYY-MM-DD before it reaches SQL. Stops
    malformed/injected date params and gives a clean 422 instead of an empty page."""
    if not _DATE_RE.match(date or ""):
        raise HTTPException(422, "date must be in YYYY-MM-DD form")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(422, "not a valid calendar date")
    return date


def _valid_id(value: str, label: str) -> str:
    if not value or not _ID_RE.match(value):
        raise HTTPException(422, f"invalid {label}")
    return value


def _require_zone(conn, zone_id: str) -> dict:
    """422 on a bad id shape, 404 when the zone does not exist."""
    _valid_id(zone_id, "zone id")
    row = conn.execute("SELECT * FROM zones WHERE id=?", (zone_id,)).fetchone()
    if not row:
        raise HTTPException(404, "unknown zone")
    return dict(row)


# --------------------------------------------------------------------------- #
# Pricing + Razorpay payment helpers
# --------------------------------------------------------------------------- #
def _price_for(conn, slot_type: str, vtype: str) -> int | None:
    """Fare in rupees for a lane+vehicle, or None if unpriced. Emergency is free."""
    if vtype == "emergency":
        return 0
    row = conn.execute(
        "SELECT price FROM pricing WHERE slot_type=? AND vtype=?",
        (slot_type, vtype),
    ).fetchone()
    return row["price"] if row else None


def _pricing_table(conn) -> dict:
    out: dict[str, dict[str, int]] = {"public": {}, "vip": {}}
    for r in conn.execute("SELECT slot_type,vtype,price FROM pricing"):
        out.setdefault(r["slot_type"], {})[r["vtype"]] = r["price"]
    return out


def _create_razorpay_order(amount_paise: int, receipt: str, notes: dict) -> str:
    """Create a real Razorpay order, returning its order_id. Raises on failure."""
    try:
        with httpx.Client(timeout=10.0) as cl:
            resp = cl.post(
                RAZORPAY_ORDERS_URL,
                auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET),
                json={"amount": amount_paise, "currency": "INR",
                      "receipt": receipt, "notes": notes, "payment_capture": 1},
            )
            resp.raise_for_status()
            return resp.json()["id"]
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(502, f"payment gateway error: {exc}") from exc


def _verify_razorpay_signature(order_id: str, payment_id: str, signature: str) -> bool:
    """Razorpay's checkout signature = HMAC-SHA256(order_id|payment_id, key_secret)."""
    if not (order_id and payment_id and signature):
        return False
    body = f"{order_id}|{payment_id}".encode()
    expected = hmac.new(RAZORPAY_KEY_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def audit(conn, actor: str, action: str, detail: str = "") -> None:
    conn.execute(
        "INSERT INTO audit_log(ts,actor,action,detail) VALUES(?,?,?,?)",
        (now_iso(), actor, action, detail),
    )


@app.on_event("startup")
def _startup() -> None:
    tickets.ensure_keys()
    tickets.ensure_plate_secret()
    auth.ensure_secret()
    db.init_db()
    mode = f"LIVE (key {RAZORPAY_KEY_ID[:12]}…)" if RAZORPAY_LIVE else "MOCK (no keys — set RAZORPAY_KEY_ID/SECRET)"
    print(f"[payments] Razorpay mode: {mode}", file=sys.stderr)
    # Start the opportunistic cloud mirror (SQLite stays source of truth; this
    # pushes deltas to MongoDB when a link exists). No-op unless MONGO_URI is set.
    mongo_sync.start()


# --------------------------------------------------------------------------- #
# Sessions — SINGLE active session per identity.
#
# Tokens stay stateless-signed, but each carries an opaque `sid`. The latest login
# for a subject overwrites the `sid` stored in the sessions table, so any earlier
# token (whose sid no longer matches) is instantly dead — one device/tab at a time
# per username and per citizen phone. Logout deletes the row, killing the token.
# --------------------------------------------------------------------------- #
def _open_session(conn, subject: str, role: str) -> str:
    """Mint a new session id for `subject`, evicting any previous one. Returns sid."""
    sid = uuid.uuid4().hex
    ts = now_iso()
    conn.execute(
        "INSERT INTO sessions(subject,role,sid,created_at,last_seen) VALUES(?,?,?,?,?)"
        " ON CONFLICT(subject) DO UPDATE SET sid=excluded.sid, role=excluded.role,"
        " created_at=excluded.created_at, last_seen=excluded.last_seen",
        (subject, role, sid, ts, ts),
    )
    return sid


def _session_live(subject: str, sid: str) -> bool:
    if not subject or not sid:
        return False
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT sid FROM sessions WHERE subject=?", (subject,)
        ).fetchone()
    finally:
        conn.close()
    return bool(row) and hmac.compare_digest(row["sid"], sid)


# --------------------------------------------------------------------------- #
# Auth dependencies (role-bound bearer tokens). See docs/AUDIT.md §4 move 1.
# --------------------------------------------------------------------------- #
def _principal(authorization: str | None):
    """Verify the bearer token's signature/expiry AND that its session is still the
    live one for the subject (single-session). A superseded or logged-out token
    verifies cryptographically but fails the session check → treated as anonymous."""
    payload = auth.verify_token(auth.bearer(authorization))
    if not payload:
        return None
    if not _session_live(payload.get("sub"), payload.get("sid")):
        return None
    return payload


def staff_dep(authorization: str | None = Header(None)) -> dict:
    p = _principal(authorization)
    if not p or p.get("role") not in STAFF_ROLES:
        raise HTTPException(401, "staff authentication required")
    return p


def commander_dep(authorization: str | None = Header(None)) -> dict:
    p = _principal(authorization)
    if not p or p.get("role") != "commander":
        raise HTTPException(403, "commander authentication required")
    return p


def citizen_dep(authorization: str | None = Header(None)) -> dict:
    p = _principal(authorization)
    if not p or p.get("role") != "citizen":
        raise HTTPException(401, "citizen authentication required")
    return p


def node_dep(authorization: str | None = Header(None)) -> dict:
    """Authenticate a checkpoint node by its per-node sync token."""
    tok = auth.bearer(authorization)
    if not tok:
        raise HTTPException(401, "node token required")
    conn = db.connect()
    cp = conn.execute("SELECT * FROM checkpoints WHERE token=?", (tok,)).fetchone()
    conn.close()
    if not cp:
        raise HTTPException(401, "invalid node token")
    return dict(cp)


def _authenticate(conn, username: str, password: str) -> dict | None:
    u = conn.execute("SELECT * FROM users WHERE id=?", (username,)).fetchone()
    if not u or not auth.verify_password(password, u["pw_hash"], u["pw_salt"]):
        return None
    return dict(u)


# --------------------------------------------------------------------------- #
# Auth endpoints
# --------------------------------------------------------------------------- #
class LoginReq(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@app.post("/api/auth/login")
def login(req: LoginReq):
    """Staff login (commander / dispatcher / operator). Single-session: this login
    supersedes any previous one for the same username (older token goes dead)."""
    conn = db.connect()
    try:
        u = _authenticate(conn, req.username.strip().lower(), req.password)
        if not u:
            raise HTTPException(401, "invalid credentials")
        sid = _open_session(conn, u["id"], u["role"])
        conn.commit()
    finally:
        conn.close()
    token = auth.make_token({"sub": u["id"], "role": u["role"], "sid": sid,
                             "name": u["display_name"], "zone": u["zone_id"]})
    return {"token": token, "role": u["role"], "name": u["display_name"],
            "zone": u["zone_id"]}


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(None)):
    """End the current session (deletes the row → the token is immediately dead)."""
    p = _principal(authorization)
    if not p:
        raise HTTPException(401, "not authenticated")
    conn = db.connect()
    conn.execute("DELETE FROM sessions WHERE subject=?", (p["sub"],))
    conn.commit()
    conn.close()
    return {"ok": True}


def _norm_phone(phone: str) -> str:
    digits = "".join(c for c in (phone or "") if c.isdigit())
    return digits[-10:] if len(digits) >= 10 else digits


class OtpReq(BaseModel):
    phone: str = Field(min_length=5, max_length=20)


@app.post("/api/auth/otp/request")
def otp_request(req: OtpReq):
    """Citizen phone verification (anti-tout identity binding). Prototype: the OTP
    is generated server-side and returned as demo_otp; a real SMS gateway sends it."""
    phone = _norm_phone(req.phone)
    if len(phone) != 10:
        raise HTTPException(400, "enter a 10-digit mobile number")
    code = f"{int.from_bytes(os.urandom(3), 'big') % 1000000:06d}"
    exp = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    conn = db.connect()
    conn.execute(
        "INSERT INTO otp_codes(phone,code,expires,attempts) VALUES(?,?,?,0)"
        " ON CONFLICT(phone) DO UPDATE SET code=excluded.code,"
        " expires=excluded.expires, attempts=0",
        (phone, code, exp),
    )
    conn.commit()
    conn.close()
    return {"sent": True, "phone": phone, "demo_otp": code,
            "note": "demo: OTP shown here; production sends it by SMS"}


class OtpVerify(BaseModel):
    phone: str = Field(min_length=5, max_length=20)
    code: str = Field(min_length=4, max_length=8)

    @field_validator("code")
    @classmethod
    def _digits(cls, v: str) -> str:
        if not v.strip().isdigit():
            raise ValueError("OTP must be numeric")
        return v.strip()


@app.post("/api/auth/otp/verify")
def otp_verify(req: OtpVerify):
    phone = _norm_phone(req.phone)
    conn = db.connect()
    row = conn.execute("SELECT * FROM otp_codes WHERE phone=?", (phone,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(400, "request an OTP first")
    if row["attempts"] >= 5:
        conn.close()
        raise HTTPException(429, "too many attempts — request a new OTP")
    conn.execute("UPDATE otp_codes SET attempts=attempts+1 WHERE phone=?", (phone,))
    conn.commit()
    expired = datetime.fromisoformat(row["expires"]) < datetime.now(timezone.utc)
    if expired or req.code.strip() != row["code"]:
        conn.close()
        raise HTTPException(401, "incorrect or expired OTP")
    conn.execute("DELETE FROM otp_codes WHERE phone=?", (phone,))
    # Single-session for citizens too: a fresh verify on a new phone/device kills
    # the old token, so a leaked pass-list token can't outlive a re-login.
    sid = _open_session(conn, phone, "citizen")
    conn.commit()
    conn.close()
    token = auth.make_token({"sub": phone, "role": "citizen", "sid": sid},
                            ttl_seconds=72 * 3600)
    return {"token": token, "phone": phone}


# --------------------------------------------------------------------------- #
# Citizen booking layer
# --------------------------------------------------------------------------- #
def _slot_booked(conn, slot_id: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(vcount),0) AS n FROM bookings"
        " WHERE slot_id=? AND status IN ('booked','arrived')",
        (slot_id,),
    ).fetchone()
    return row["n"]


def _zone_lots(conn, zone_id: str) -> list:
    """Lots for a zone in overflow-cascade order (primary first)."""
    return conn.execute(
        "SELECT id,zone_id,name,capacity,cascade_ord,lat,lng FROM lots"
        " WHERE zone_id=? ORDER BY cascade_ord", (zone_id,),
    ).fetchall()


def _primary_lot(conn, zone_id: str):
    """The booked/intended lot tagged at booking time = cascade_ord 0. NOT signed
    into the pass; it's mutable operational data the gate may override (§9)."""
    row = conn.execute(
        "SELECT id,name,lat,lng FROM lots WHERE zone_id=? ORDER BY cascade_ord LIMIT 1",
        (zone_id,),
    ).fetchone()
    return row


def _zone_physical_capacity(conn, zone_id: str) -> int:
    """Total physical spaces across the zone's lots — the real ceiling."""
    return conn.execute(
        "SELECT COALESCE(SUM(capacity),0) AS c FROM lots WHERE zone_id=?",
        (zone_id,),
    ).fetchone()["c"]


def _zone_active_count(conn, zone_id: str, date: str) -> int:
    """Active (booked+arrived) vehicle footprint for a zone on a date — what
    counts against the physical ceiling. No-shows/departed/revoked are excluded
    (so the no-show sweep and gate-out exits reclaim capacity)."""
    return conn.execute(
        "SELECT COALESCE(SUM(b.vcount),0) AS n FROM bookings b"
        " JOIN slots s ON s.id=b.slot_id"
        " WHERE b.zone_id=? AND s.date=? AND b.status IN ('booked','arrived')",
        (zone_id, date),
    ).fetchone()["n"]


def _active_lockdown_scope(conn, zone_id: str) -> str | None:
    row = conn.execute(
        "SELECT scope FROM lockdowns WHERE active=1 AND scope IN ('ALL', ?)"
        " ORDER BY id DESC LIMIT 1",
        (zone_id,),
    ).fetchone()
    return row["scope"] if row else None


@app.get("/api/zones")
def list_zones(date: str):
    _valid_date(date)
    conn = db.connect()
    out = []
    for z in conn.execute("SELECT * FROM zones ORDER BY id").fetchall():
        cap = conn.execute(
            "SELECT COALESCE(SUM(capacity),0) AS c FROM slots"
            " WHERE zone_id=? AND date=? AND slot_type='public'",
            (z["id"], date),
        ).fetchone()["c"]
        booked = conn.execute(
            "SELECT COALESCE(SUM(b.vcount),0) AS n FROM bookings b"
            " JOIN slots s ON s.id=b.slot_id"
            " WHERE b.zone_id=? AND s.date=? AND b.slot_type='public'"
            " AND b.status IN ('booked','arrived')",
            (z["id"], date),
        ).fetchone()["n"]
        out.append({
            "id": z["id"], "name": z["name"], "road": z["road"],
            "lng": z["lng"], "lat": z["lat"],
            "capacity": cap, "booked": booked,
            "available": max(cap - booked, 0),
            "locked": _active_lockdown_scope(conn, z["id"]) is not None,
        })
    conn.close()
    return out


@app.get("/api/zones/{zone_id}/slots")
def zone_slots(zone_id: str, date: str, slot_type: str = "public"):
    _valid_date(date)
    if slot_type not in ("public", "vip"):
        raise HTTPException(422, "slot_type must be 'public' or 'vip'")
    conn = db.connect()
    _require_zone(conn, zone_id)
    rows = conn.execute(
        "SELECT * FROM slots WHERE zone_id=? AND date=? AND slot_type=?"
        " ORDER BY start",
        (zone_id, date, slot_type),
    ).fetchall()
    out = []
    for s in rows:
        booked = _slot_booked(conn, s["id"])
        out.append({
            "id": s["id"], "date": s["date"], "start": s["start"], "end": s["end"],
            "capacity": s["capacity"], "booked": booked,
            "available": max(s["capacity"] - booked, 0),
            "slot_type": s["slot_type"],
        })
    conn.close()
    if not out:
        raise HTTPException(404, "no slots for zone/date")
    return out


@app.get("/api/zones/{zone_id}/lots")
def zone_lots_public(zone_id: str):
    """Real parking lots for a zone with live fill — replaces the cosmetic bay grid
    (docs/AUDIT.md C1). Citizens SEE the lots they'll be directed to; the exact lot
    is assigned at the gate (overflow cascade), so this is informational, not a
    seat-pick. `primary` is the lot a new booking is tagged to."""
    _valid_id(zone_id, "zone id")
    conn = db.connect()
    lots = _zone_lots(conn, zone_id)
    if not lots:
        conn.close()
        raise HTTPException(404, "no lots for zone")
    out = []
    for lot in lots:
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM bookings"
            " WHERE assigned_lot=? AND status='arrived'", (lot["id"],),
        ).fetchone()["n"]
        out.append({
            "id": lot["id"], "name": lot["name"], "capacity": lot["capacity"],
            "occupied": used, "available": max(lot["capacity"] - used, 0),
            "primary": lot["cascade_ord"] == 0,
        })
    conn.close()
    return out


# --------------------------------------------------------------------------- #
# Pricing — admin sets per-lane / per-vehicle fares; citizens fetch them live.
# --------------------------------------------------------------------------- #
@app.get("/api/pricing")
def get_pricing():
    """Public fare card. The citizen app reads this so prices are never hard-coded
    in the client and a fare change takes effect immediately on the next load."""
    conn = db.connect()
    table = _pricing_table(conn)
    conn.close()
    return {"currency": "INR", "pricing": table}


class PriceItem(BaseModel):
    slot_type: str = Field(pattern="^(public|vip)$")
    vtype: str = Field(pattern="^(2w|car|bus)$")
    price: int = Field(ge=0, le=1_000_000)


class PricingReq(BaseModel):
    items: list[PriceItem] = Field(min_length=1, max_length=12)


@app.post("/api/admin/pricing")
def set_pricing(req: PricingReq, commander: dict = Depends(commander_dep)):
    """Set one or more fares (lane × vehicle). Upserts each cell."""
    conn = db.connect()
    for it in req.items:
        conn.execute(
            "INSERT INTO pricing(slot_type,vtype,price) VALUES(?,?,?)"
            " ON CONFLICT(slot_type,vtype) DO UPDATE SET price=excluded.price",
            (it.slot_type, it.vtype, it.price),
        )
    audit(conn, commander["name"], "pricing.set",
          ", ".join(f"{i.slot_type}/{i.vtype}=₹{i.price}" for i in req.items))
    conn.commit()
    table = _pricing_table(conn)
    conn.close()
    return {"ok": True, "pricing": table}


# --------------------------------------------------------------------------- #
# Payments — create a Razorpay order (real or mock). The booking is minted only
# after this order is verified at /api/bookings (server-authoritative amount).
# --------------------------------------------------------------------------- #
# One vehicle in a multi-vehicle order: its type, number plate, optional
# colour/model, and how many people travel in it (headcount only — no personal
# details are ever stored, just the number).
class CartItem(BaseModel):
    vtype: str = Field(pattern="^(2w|car|bus)$")
    plate: str = Field(min_length=2, max_length=20)
    vdesc: str | None = Field(default=None, max_length=60)
    pax: int = Field(default=1, ge=1, le=100)


class OrderReq(BaseModel):
    slot_id: str = Field(min_length=1, max_length=128)
    slot_type: str = Field(default="public", pattern="^(public|vip)$")
    # Multi-vehicle cart: one pass is minted per item, all under a single payment.
    # `vtype`/`vcount` remain for the legacy single-vehicle path (back-compat).
    items: list[CartItem] | None = Field(default=None, max_length=50)
    vtype: str | None = Field(default=None, pattern="^(2w|car|bus)$")
    vcount: int = Field(default=1, ge=1, le=50)


@app.post("/api/payments/order")
def create_order(req: OrderReq, principal: dict = Depends(citizen_dep)):
    """Compute the fare server-side, open a Razorpay order, and stash a pending
    payment row. Returns what the checkout widget needs. In mock mode (no keys) the
    order_id is synthetic and `mock` is true so the client skips real checkout.

    With `items`, the order covers several vehicles (one pass each) under one
    payment; the cart is stored server-side so the booking step can't tamper it."""
    phone = principal["sub"]
    conn = db.connect()
    slot = conn.execute("SELECT * FROM slots WHERE id=?", (req.slot_id,)).fetchone()
    if not slot:
        conn.close()
        raise HTTPException(404, "unknown slot")
    if slot["slot_type"] != req.slot_type:
        conn.close()
        raise HTTPException(400, "slot_type mismatch")

    # Normalise to a cart either way, so pricing + storage are uniform.
    if req.items:
        cart = [{"vtype": it.vtype, "plate": tickets.normalize_plate(it.plate),
                 "vdesc": (it.vdesc or "").strip()[:40], "pax": it.pax}
                for it in req.items]
    else:
        if not req.vtype:
            conn.close()
            raise HTTPException(400, "no vehicles in order")
        cart = [{"vtype": req.vtype, "plate": "", "vdesc": "", "pax": 1}
                for _ in range(req.vcount)]

    amount = 0
    for it in cart:
        unit = _price_for(conn, req.slot_type, it["vtype"])
        if unit is None:
            conn.close()
            raise HTTPException(400, f"no price configured for {req.slot_type}/{it['vtype']}")
        amount += unit
    receipt = f"vms-{uuid.uuid4().hex[:12]}"
    if RAZORPAY_LIVE:
        order_id = _create_razorpay_order(
            amount * 100, receipt,
            {"phone": phone, "slot": req.slot_id, "lane": req.slot_type})
    else:
        order_id = f"order_mock_{uuid.uuid4().hex}"
    # vtype column kept for back-compat/reporting; cart is the authoritative list.
    head_vtype = cart[0]["vtype"] if len(cart) == 1 else "mixed"
    conn.execute(
        "INSERT INTO payments(order_id,phone,slot_id,vtype,vcount,slot_type,amount,"
        "cart,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'created', ?)",
        (order_id, phone, req.slot_id, head_vtype, len(cart), req.slot_type,
         amount, json.dumps(cart), now_iso()),
    )
    conn.commit()
    conn.close()
    desc = (f"{req.slot_type.upper()} entry · {len(cart)} vehicle"
            f"{'s' if len(cart) != 1 else ''}")
    return {
        "order_id": order_id, "amount": amount, "amount_paise": amount * 100,
        "currency": "INR", "key_id": RAZORPAY_KEY_ID, "mock": not RAZORPAY_LIVE,
        "name": "Ujjain VMS", "description": desc, "vehicles": len(cart),
    }


class BookingReq(BaseModel):
    slot_id: str = Field(min_length=1, max_length=128)
    vtype: str = Field(pattern="^(2w|car|bus|emergency)$")
    vcount: int = Field(default=1, ge=1, le=50)
    plate: str | None = Field(default=None, max_length=20)
    vdesc: str | None = Field(default=None, max_length=60)  # colour/model, aids gate check
    slot_type: str = Field(default="public", pattern="^(public|vip)$")
    # Razorpay proof — required for paid (non-emergency) bookings. The order_id ties
    # back to the server-computed amount; signature is checked in LIVE mode.
    razorpay_order_id: str | None = Field(default=None, max_length=64)
    razorpay_payment_id: str | None = Field(default=None, max_length=64)
    razorpay_signature: str | None = Field(default=None, max_length=256)


def _qr_data_url(token: str) -> str:
    img = qrcode.make(token)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


@app.post("/api/bookings")
def create_booking(req: BookingReq, authorization: str | None = Header(None)):
    # Identity gate (docs/AUDIT.md C3, C13). Emergency passes are privileged —
    # only a dispatcher/commander may issue them, closing the self-issue hole.
    # Public vehicles require a phone-verified citizen token so bookings can be
    # capped per identity (anti-tout).
    principal = _principal(authorization)
    phone = None
    if req.vtype == "emergency":
        if not principal or principal.get("role") not in ("dispatcher", "commander"):
            raise HTTPException(403, "emergency passes require a dispatcher/commander")
    else:
        if not principal or principal.get("role") != "citizen":
            raise HTTPException(401, "verify your phone number to book")
        phone = principal["sub"]
        # Paid lane: a verified Razorpay order must back the booking (anti-tamper —
        # the amount lives on the server order, not the request).
        if not req.razorpay_order_id:
            raise HTTPException(402, "payment required — create an order first")

    # Autocommit mode so we can hold an explicit BEGIN IMMEDIATE around the
    # read-check-insert. BEGIN IMMEDIATE takes SQLite's reserved write lock up
    # front, serialising concurrent bookings for the same slot and closing the
    # check-then-insert overbooking race.
    conn = db.connect()
    conn.isolation_level = None
    try:
        slot = conn.execute("SELECT * FROM slots WHERE id=?", (req.slot_id,)).fetchone()
        if not slot:
            raise HTTPException(404, "unknown slot")
        if slot["slot_type"] != req.slot_type:
            raise HTTPException(400, "slot_type mismatch")

        # Per-identity cap for the event date (anti-tout, C13).
        if phone:
            active = conn.execute(
                "SELECT COUNT(*) AS n FROM bookings b JOIN slots s ON s.id=b.slot_id"
                " WHERE b.phone=? AND s.date=? AND b.status IN ('booked','arrived')",
                (phone, slot["date"]),
            ).fetchone()["n"]
            if active >= BOOKING_CAP_PER_PHONE:
                raise HTTPException(
                    429, f"booking limit reached ({BOOKING_CAP_PER_PHONE} per phone "
                         f"for {slot['date']})")

        bid = uuid.uuid4().hex
        code = tickets.human_code(bid)
        plate = tickets.normalize_plate(req.plate)
        vdesc = (req.vdesc or "").strip()[:40]
        lot = _primary_lot(conn, slot["zone_id"])   # intended lot (mutable, unsigned)
        lot_id = lot["id"] if lot else None
        lot_name = lot["name"] if lot else None
        lot_lat = lot["lat"] if lot else None
        lot_lng = lot["lng"] if lot else None
        # Hard expiry = slot end + grace, in UTC. The slot times are naive local
        # clock strings; treat them as UTC for the prototype (single timezone).
        exp = (datetime.fromisoformat(f"{slot['date']}T{slot['end']}:00+00:00")
               + timedelta(hours=TICKET_EXP_GRACE_HOURS)).isoformat()
        payload = {
            "v": tickets.PAYLOAD_VERSION, "kid": tickets.KEY_ID,
            "bid": bid, "zone": slot["zone_id"], "slot": slot["id"],
            "date": slot["date"], "ws": slot["start"], "we": slot["end"],
            "vt": req.vtype, "vc": req.vcount, "st": req.slot_type,
            # Plate is carried as a keyed HMAC + last-4 only, never cleartext (C8).
            "ph": tickets.plate_hash(plate) if plate else "",
            "pl": tickets.plate_last4(plate), "vdesc": vdesc,
            "iat": now_iso(), "exp": exp, "jti": uuid.uuid4().hex,
        }
        # Sign + render QR BEFORE the write so a crypto/QR failure can't leave an
        # orphaned committed booking with no ticket returned.
        token = tickets.sign_ticket(payload)
        qr = _qr_data_url(token)
        footprint = VEHICLE_FOOTPRINT[req.vtype] * req.vcount

        conn.execute("BEGIN IMMEDIATE")
        try:
            if _active_lockdown_scope(conn, slot["zone_id"]):
                raise HTTPException(423, "zone under lockdown — bookings suspended")
            if _slot_booked(conn, slot["id"]) + footprint > slot["capacity"]:
                raise HTTPException(409, "slot full")
            # Physical ceiling: don't oversell the zone's lots beyond the overbook
            # ratio (C4). Emergency vehicles (footprint 0) bypass this.
            phys = _zone_physical_capacity(conn, slot["zone_id"])
            if phys and footprint and (
                    _zone_active_count(conn, slot["zone_id"], slot["date"]) + footprint
                    > round(phys * OVERBOOK_RATIO)):
                raise HTTPException(409, "zone parking sold out for this date")
            # Payment: consume the matching pending order inside the same lock, so a
            # single paid order yields exactly one booking. Emergency is free.
            amount = 0
            if req.vtype != "emergency":
                pay = conn.execute(
                    "SELECT * FROM payments WHERE order_id=?",
                    (req.razorpay_order_id,)).fetchone()
                if not pay:
                    raise HTTPException(400, "unknown payment order")
                if pay["status"] != "created":
                    raise HTTPException(409, "payment already used")
                if pay["phone"] != phone:
                    raise HTTPException(403, "payment belongs to another user")
                if (pay["slot_id"] != slot["id"] or pay["vtype"] != req.vtype
                        or pay["vcount"] != req.vcount
                        or pay["slot_type"] != req.slot_type):
                    raise HTTPException(400, "payment does not match this booking")
                if RAZORPAY_LIVE and not _verify_razorpay_signature(
                        req.razorpay_order_id, req.razorpay_payment_id,
                        req.razorpay_signature):
                    raise HTTPException(400, "payment signature verification failed")
                amount = pay["amount"]
                conn.execute(
                    "UPDATE payments SET status='consumed', payment_id=?, booking_id=?"
                    " WHERE order_id=?",
                    (req.razorpay_payment_id, bid, req.razorpay_order_id),
                )
            ts = now_iso()
            conn.execute(
                "INSERT INTO bookings(id,slot_id,zone_id,vtype,vcount,plate,vdesc,"
                "lot_id,phone,status,code,token,slot_type,amount,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?, 'booked', ?,?,?,?,?,?)",
                (bid, slot["id"], slot["zone_id"], req.vtype, req.vcount, plate, vdesc,
                 lot_id, phone, code, token, req.slot_type, amount, ts, ts),
            )
            actor = phone or (principal.get("name") if principal else "citizen")
            audit(conn, actor, "booking.create",
                  f"{bid} {slot['zone_id']} {slot['start']} {req.vtype} ₹{amount}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()

    window = f"{slot['start']}–{slot['end']}"
    # Simulated SMS fallback (Section 5.6): on a ₹2k phone the QR may not render,
    # so the same 6-char code arrives by SMS. Here we just return the text the
    # gateway would send; a real PSP/SMS provider drops in behind this.
    park = f" Park at {lot_name}." if lot_name else ""
    sms = (f"UJJAIN VMS: {req.slot_type.upper()} slot booked. "
           f"{slot['zone_id'].title()} {slot['date']} {window}.{park} "
           f"Entry code {code}. Show QR or quote code at the gate.")
    return {
        "id": bid, "code": code, "token": token, "qr": qr,
        "zone": slot["zone_id"], "date": slot["date"], "window": window,
        "vtype": req.vtype, "vcount": req.vcount, "slot_type": req.slot_type,
        "plate": plate, "vdesc": vdesc, "amount": amount,
        "lot_id": lot_id, "lot_name": lot_name,
        "lot_lat": lot_lat, "lot_lng": lot_lng, "sms": sms,
    }


def _mint_booking(conn, slot, *, vtype, vcount, plate_raw, vdesc_raw, slot_type,
                  phone, pax, amount):
    """Sign one pass + insert one booking row inside an already-open transaction.
    Returns the citizen-facing pass dict. Caller owns the txn + capacity checks."""
    bid = uuid.uuid4().hex
    code = tickets.human_code(bid)
    plate = tickets.normalize_plate(plate_raw)
    vdesc = (vdesc_raw or "").strip()[:40]
    lot = _primary_lot(conn, slot["zone_id"])
    lot_id = lot["id"] if lot else None
    lot_name = lot["name"] if lot else None
    lot_lat = lot["lat"] if lot else None
    lot_lng = lot["lng"] if lot else None
    exp = (datetime.fromisoformat(f"{slot['date']}T{slot['end']}:00+00:00")
           + timedelta(hours=TICKET_EXP_GRACE_HOURS)).isoformat()
    payload = {
        "v": tickets.PAYLOAD_VERSION, "kid": tickets.KEY_ID,
        "bid": bid, "zone": slot["zone_id"], "slot": slot["id"],
        "date": slot["date"], "ws": slot["start"], "we": slot["end"],
        "vt": vtype, "vc": vcount, "st": slot_type,
        "ph": tickets.plate_hash(plate) if plate else "",
        "pl": tickets.plate_last4(plate), "vdesc": vdesc,
        "iat": now_iso(), "exp": exp, "jti": uuid.uuid4().hex,
    }
    token = tickets.sign_ticket(payload)
    qr = _qr_data_url(token)
    ts = now_iso()
    conn.execute(
        "INSERT INTO bookings(id,slot_id,zone_id,vtype,vcount,plate,vdesc,"
        "lot_id,phone,status,code,token,slot_type,amount,pax,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?,?,?, 'booked', ?,?,?,?,?,?,?)",
        (bid, slot["id"], slot["zone_id"], vtype, vcount, plate, vdesc,
         lot_id, phone, code, token, slot_type, amount, pax, ts, ts),
    )
    window = f"{slot['start']}–{slot['end']}"
    park = f" Park at {lot_name}." if lot_name else ""
    sms = (f"UJJAIN VMS: {slot_type.upper()} slot booked. "
           f"{slot['zone_id'].title()} {slot['date']} {window}.{park} "
           f"Entry code {code}. Show QR or quote code at the gate.")
    return {
        "id": bid, "code": code, "token": token, "qr": qr,
        "zone": slot["zone_id"], "date": slot["date"], "window": window,
        "vtype": vtype, "vcount": vcount, "slot_type": slot_type,
        "plate": plate, "vdesc": vdesc, "amount": amount, "pax": pax,
        "lot_id": lot_id, "lot_name": lot_name,
        "lot_lat": lot_lat, "lot_lng": lot_lng, "sms": sms,
    }


class BatchBookingReq(BaseModel):
    # The cart lives on the server (stored at order time), so the booking step only
    # needs the payment proof — the client can't change vehicles or plates here.
    razorpay_order_id: str = Field(min_length=1, max_length=64)
    razorpay_payment_id: str | None = Field(default=None, max_length=64)
    razorpay_signature: str | None = Field(default=None, max_length=256)


@app.post("/api/bookings/batch")
def create_bookings_batch(req: BatchBookingReq, principal: dict = Depends(citizen_dep)):
    """Mint one per-vehicle pass for every item in a paid multi-vehicle order.
    The whole cart is one atomic booking: capacity is checked for the total, then
    each vehicle gets its own signed QR pass. Headcount (pax) is stored per pass."""
    phone = principal["sub"]
    conn = db.connect()
    conn.isolation_level = None
    try:
        pay = conn.execute("SELECT * FROM payments WHERE order_id=?",
                           (req.razorpay_order_id,)).fetchone()
        if not pay:
            raise HTTPException(400, "unknown payment order")
        if pay["phone"] != phone:
            raise HTTPException(403, "payment belongs to another user")
        cart = json.loads(pay["cart"] or "[]")
        if not cart:
            raise HTTPException(400, "order has no vehicles")
        slot = conn.execute("SELECT * FROM slots WHERE id=?",
                            (pay["slot_id"],)).fetchone()
        if not slot:
            raise HTTPException(404, "unknown slot")
        slot_type = pay["slot_type"]

        conn.execute("BEGIN IMMEDIATE")
        try:
            if pay["status"] != "created":
                raise HTTPException(409, "payment already used")
            if RAZORPAY_LIVE and not _verify_razorpay_signature(
                    req.razorpay_order_id, req.razorpay_payment_id,
                    req.razorpay_signature):
                raise HTTPException(400, "payment signature verification failed")
            if _active_lockdown_scope(conn, slot["zone_id"]):
                raise HTTPException(423, "zone under lockdown — bookings suspended")

            footprint = sum(VEHICLE_FOOTPRINT[it["vtype"]] for it in cart)
            # Per-identity cap (anti-tout): existing active + this cart's vehicles.
            active = conn.execute(
                "SELECT COUNT(*) AS n FROM bookings b JOIN slots s ON s.id=b.slot_id"
                " WHERE b.phone=? AND s.date=? AND b.status IN ('booked','arrived')",
                (phone, slot["date"]),
            ).fetchone()["n"]
            if active + len(cart) > BOOKING_CAP_PER_PHONE:
                raise HTTPException(
                    429, f"booking limit reached ({BOOKING_CAP_PER_PHONE} vehicles "
                         f"per phone for {slot['date']})")
            if _slot_booked(conn, slot["id"]) + footprint > slot["capacity"]:
                raise HTTPException(409, "slot full")
            phys = _zone_physical_capacity(conn, slot["zone_id"])
            if phys and footprint and (
                    _zone_active_count(conn, slot["zone_id"], slot["date"]) + footprint
                    > round(phys * OVERBOOK_RATIO)):
                raise HTTPException(409, "zone parking sold out for this date")

            passes = []
            for it in cart:
                unit = _price_for(conn, slot_type, it["vtype"]) or 0
                passes.append(_mint_booking(
                    conn, slot, vtype=it["vtype"], vcount=1,
                    plate_raw=it.get("plate"), vdesc_raw=it.get("vdesc"),
                    slot_type=slot_type, phone=phone, pax=it.get("pax", 1),
                    amount=unit))
            conn.execute(
                "UPDATE payments SET status='consumed', payment_id=?, booking_id=?"
                " WHERE order_id=?",
                (req.razorpay_payment_id, passes[0]["id"], req.razorpay_order_id),
            )
            audit(conn, phone, "booking.create_batch",
                  f"{len(passes)} passes {slot['zone_id']} {slot['start']} ₹{pay['amount']}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return {"passes": passes, "amount": pay["amount"], "count": len(passes)}


@app.get("/api/bookings/{bid}")
def get_booking(bid: str):
    conn = db.connect()
    b = conn.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone()
    conn.close()
    if not b:
        raise HTTPException(404, "unknown booking")
    return dict(b)


@app.post("/api/bookings/{bid}/cancel")
def cancel_booking(bid: str, authorization: str | None = Header(None)):
    """Cancel a still-valid booking, freeing its slot + physical capacity for
    someone else. A citizen may cancel only their own; staff (dispatcher/commander)
    may cancel any. The cancellation rides the normal delta-sync to the gate, which
    then DENIES the pass offline — the same propagation path as a revocation, so a
    cancelled QR can't be used even at a disconnected checkpoint. Only 'booked'
    passes are cancellable; arrived/departed/revoked ones are historical records."""
    principal = _principal(authorization)
    if not principal:
        raise HTTPException(401, "authentication required")
    conn = db.connect()
    b = conn.execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone()
    if not b:
        conn.close()
        raise HTTPException(404, "unknown booking")
    role = principal.get("role")
    if role == "citizen":
        if b["phone"] != principal["sub"]:
            conn.close()
            raise HTTPException(403, "not your booking")
    elif role not in ("dispatcher", "commander"):
        conn.close()
        raise HTTPException(403, "not allowed to cancel")
    if b["status"] != "booked":
        conn.close()
        raise HTTPException(409, f"cannot cancel a booking that is '{b['status']}'")
    conn.execute("UPDATE bookings SET status='cancelled', updated_at=? WHERE id=?",
                 (now_iso(), bid))
    actor = (principal.get("sub") if role == "citizen" else principal.get("name")) or "citizen"
    audit(conn, actor, "booking.cancel", f"{bid} {b['zone_id']} (booked→cancelled)")
    conn.commit()
    conn.close()
    return {"ok": True, "id": bid, "status": "cancelled"}


@app.get("/api/my/bookings")
def my_bookings(principal: dict = Depends(citizen_dep)):
    """Server-side pass retrieval keyed to the verified phone (replaces
    localStorage-only passes — docs/AUDIT.md C10). Re-renders each QR from the
    stored signed token so a new device recovers full passes."""
    conn = db.connect()
    rows = conn.execute(
        "SELECT b.*, s.date AS sdate, s.start AS ws, s.end AS we,"
        " l.name AS lot_name, l.lat AS llat, l.lng AS llng"
        " FROM bookings b JOIN slots s ON s.id=b.slot_id"
        " LEFT JOIN lots l ON l.id=COALESCE(b.assigned_lot, b.lot_id)"
        " WHERE b.phone=? AND b.status!='cancelled' ORDER BY b.created_at DESC LIMIT 50",
        (principal["sub"],),
    ).fetchall()
    conn.close()
    out = []
    for b in rows:
        out.append({
            "id": b["id"], "code": b["code"], "token": b["token"],
            "qr": _qr_data_url(b["token"]),
            "zone": b["zone_id"], "date": b["sdate"],
            "window": f"{b['ws']}–{b['we']}", "vtype": b["vtype"],
            "vcount": b["vcount"], "slot_type": b["slot_type"], "status": b["status"],
            "plate": b["plate"], "vdesc": b["vdesc"], "lot_name": b["lot_name"],
            "lot_lat": b["llat"], "lot_lng": b["llng"], "amount": b["amount"],
            "pax": b["pax"],
        })
    return out


# --------------------------------------------------------------------------- #
# Admin / command centre
# --------------------------------------------------------------------------- #
@app.get("/api/admin/overview")
def admin_overview(date: str, principal: dict = Depends(staff_dep)):
    _valid_date(date)
    conn = db.connect()
    zones = []
    for z in conn.execute("SELECT * FROM zones ORDER BY id").fetchall():
        agg = conn.execute(
            "SELECT "
            " COALESCE(SUM(CASE WHEN b.status IN ('booked','arrived') THEN b.vcount END),0) AS booked,"
            " COALESCE(SUM(CASE WHEN b.status='arrived' THEN b.vcount END),0) AS arrived,"
            " COALESCE(SUM(CASE WHEN b.status='noshow' THEN b.vcount END),0) AS noshow,"
            " COALESCE(SUM(CASE WHEN b.status='revoked' THEN b.vcount END),0) AS revoked"
            " FROM bookings b JOIN slots s ON s.id=b.slot_id"
            " WHERE b.zone_id=? AND s.date=?",
            (z["id"], date),
        ).fetchone()
        cap = conn.execute(
            "SELECT COALESCE(SUM(capacity),0) AS c FROM slots"
            " WHERE zone_id=? AND date=? AND slot_type='public'",
            (z["id"], date),
        ).fetchone()["c"]
        cp = conn.execute(
            "SELECT id,last_sync FROM checkpoints WHERE zone_id=?", (z["id"],)
        ).fetchone()
        zones.append({
            "id": z["id"], "name": z["name"], "road": z["road"],
            "capacity": cap, "booked": agg["booked"], "arrived": agg["arrived"],
            "noshow": agg["noshow"], "revoked": agg["revoked"],
            "checkpoint_id": cp["id"] if cp else None,
            "last_sync": cp["last_sync"] if cp else None,
            "locked": _active_lockdown_scope(conn, z["id"]) is not None,
        })
    lockdowns = [dict(r) for r in conn.execute(
        "SELECT * FROM lockdowns WHERE active=1").fetchall()]
    conn.close()
    return {"date": date, "zones": zones, "lockdowns": lockdowns,
            "server_time": now_iso()}


class LockdownReq(BaseModel):
    scope: str = Field(min_length=1, max_length=64)  # zone id or 'ALL'
    reason: str = Field(default="", max_length=280)


def _scope_where(scope: str) -> tuple[str, tuple]:
    """SQL fragment + params selecting bookings in a lockdown scope."""
    if scope == "ALL":
        return "1=1", ()
    return "zone_id=?", (scope,)


@app.post("/api/admin/lockdown")
def set_lockdown(req: LockdownReq, commander: dict = Depends(commander_dep)):
    """ACTIVATE is single-commander and fast — slamming the brakes on is the safe
    direction (Mauni Amavasya). LIFTING needs two people (see /lift)."""
    conn = db.connect()
    if req.scope != "ALL":
        _require_zone(conn, req.scope)   # 'ALL' or a real zone — nothing else
    conn.execute(
        "UPDATE lockdowns SET active=0 WHERE scope=? AND active=1", (req.scope,)
    )
    cur = conn.execute(
        "INSERT INTO lockdowns(scope,active,reason,actor,created_at) VALUES(?,1,?,?,?)",
        (req.scope, req.reason, commander["name"], now_iso()),
    )
    ld_id = str(cur.lastrowid)
    # "Revoke everything" — and TAG each revocation with this lockdown id so the
    # lift restores ONLY what this lockdown killed (docs/AUDIT.md C7).
    where, params = _scope_where(req.scope)
    cur = conn.execute(
        f"UPDATE bookings SET status='revoked', revoked_by=?, updated_at=? "
        f"WHERE status='booked' AND {where}",
        (ld_id, now_iso(), *params),
    )
    audit(conn, commander["name"], "lockdown.activate",
          f"{req.scope}: {req.reason} (revoked {cur.rowcount} bookings)")
    conn.commit()
    conn.close()
    return {"ok": True, "scope": req.scope, "active": True, "revoked": cur.rowcount}


class LiftReq(BaseModel):
    second_username: str
    second_password: str


@app.post("/api/admin/lockdown/{scope}/lift")
def lift_lockdown(scope: str, req: LiftReq,
                  commander: dict = Depends(commander_dep)):
    """TWO-PERSON lift. Re-opening during a crisis is the dangerous direction, so
    it requires a SECOND, distinct commander to authenticate inline (docs/AUDIT.md
    C2). Restores only bookings this lockdown revoked (cause-tagged, C7)."""
    conn = db.connect()
    second = _authenticate(conn, req.second_username.strip().lower(),
                           req.second_password)
    if not second or second["role"] != "commander":
        conn.close()
        raise HTTPException(403, "a second commander must authenticate to lift")
    if second["id"] == commander["sub"]:
        conn.close()
        raise HTTPException(403, "the second approver must be a different commander")

    lds = conn.execute(
        "SELECT id FROM lockdowns WHERE scope=? AND active=1", (scope,)
    ).fetchall()
    if not lds:
        conn.close()
        raise HTTPException(404, "no active lockdown for that scope")
    conn.execute("UPDATE lockdowns SET active=0 WHERE scope=? AND active=1", (scope,))
    restored = 0
    for ld in lds:
        cur = conn.execute(
            "UPDATE bookings SET status='booked', revoked_by=NULL, updated_at=?"
            " WHERE status='revoked' AND revoked_by=?", (now_iso(), str(ld["id"])))
        restored += cur.rowcount
    audit(conn, f"{commander['name']} + {second['display_name']}", "lockdown.lift",
          f"{scope} (two-person; restored {restored} bookings)")
    conn.commit()
    conn.close()
    return {"ok": True, "scope": scope, "active": False, "restored": restored,
            "approvers": [commander["name"], second["display_name"]]}


class CapacityReq(BaseModel):
    zone_id: str = Field(min_length=1, max_length=64)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    capacity: int = Field(ge=0, le=100000)
    slot_type: str = Field(default="public", pattern="^(public|vip)$")


@app.post("/api/admin/capacity")
def set_capacity(req: CapacityReq, commander: dict = Depends(commander_dep)):
    """Capacity planner (Section 9.1): set every slot's capacity for a zone/date."""
    _valid_date(req.date)
    conn = db.connect()
    _require_zone(conn, req.zone_id)
    cur = conn.execute(
        "UPDATE slots SET capacity=? WHERE zone_id=? AND date=? AND slot_type=?",
        (req.capacity, req.zone_id, req.date, req.slot_type),
    )
    audit(conn, "command-centre", "capacity.set",
          f"{req.zone_id} {req.date} {req.slot_type} -> {req.capacity} ({cur.rowcount} slots)")
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, "no slots matched zone/date")
    return {"ok": True, "updated_slots": cur.rowcount, "capacity": req.capacity}


class ReconcileReq(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    as_of: str | None = None   # reconcile windows that ended before this instant

    @field_validator("as_of")
    @classmethod
    def _iso(cls, v: str | None) -> str | None:
        if v:
            try:
                datetime.fromisoformat(v)
            except ValueError as exc:
                raise ValueError("as_of must be ISO-8601") from exc
        return v


@app.post("/api/admin/reconcile")
def reconcile_noshows(req: ReconcileReq, commander: dict = Depends(commander_dep)):
    """Mark still-`booked` vehicles whose arrival window has elapsed as `noshow`,
    reclaiming their capacity (C6). `as_of` defaults to now; the command UI passes
    end-of-day so the 2028-dated demo can show reclaim without time travel."""
    as_of = req.as_of or now_iso()
    grace_h = TICKET_EXP_GRACE_HOURS
    conn = db.connect()
    cur = conn.execute(
        "UPDATE bookings SET status='noshow', updated_at=?"
        " WHERE status='booked' AND slot_id IN ("
        "  SELECT s.id FROM slots s WHERE s.date=?"
        f"   AND datetime(s.date || 'T' || s.end, '+{grace_h} hours') < datetime(?))",
        (now_iso(), req.date, as_of),
    )
    audit(conn, commander["name"], "reconcile.noshow",
          f"{req.date} as_of {as_of}: {cur.rowcount} marked no-show")
    conn.commit()
    conn.close()
    return {"ok": True, "date": req.date, "noshow": cur.rowcount}


@app.get("/api/admin/lots")
def admin_lots(zone_id: str, principal: dict = Depends(staff_dep)):
    """Per-lot physical occupancy for a zone, reconciled from synced assignment
    events (bookings.assigned_lot). Shows overflow visibly at the command centre."""
    conn = db.connect()
    _require_zone(conn, zone_id)
    out = []
    for lot in _zone_lots(conn, zone_id):
        used = conn.execute(
            "SELECT COUNT(*) AS n FROM bookings"
            " WHERE assigned_lot=? AND status='arrived'", (lot["id"],),
        ).fetchone()["n"]
        out.append({
            "id": lot["id"], "name": lot["name"], "capacity": lot["capacity"],
            "cascade_ord": lot["cascade_ord"], "occupied": used,
            "available": max(lot["capacity"] - used, 0),
            "lat": lot["lat"], "lng": lot["lng"],
        })
    conn.close()
    return {"zone_id": zone_id, "lots": out}


@app.get("/api/admin/audit")
def get_audit(limit: int = 80, principal: dict = Depends(staff_dep)):
    """Unified, detailed activity feed. Merges the administrative audit_log
    (bookings, lockdowns, capacity, reconciliation, node sync) with the gate
    decisions ingested from checkpoints (admit / deny / exit). Gate rows carry the
    offline flag and the vehicle/zone they relate to, so the command centre can see
    *what* a gate did and *whether it was offline at the time* — the part that was
    previously invisible. Newest first."""
    limit = max(1, min(limit, 500))      # bound the fan-out / response size
    conn = db.connect()
    admin_rows = conn.execute(
        "SELECT id, ts, actor, action, detail FROM audit_log"
        " ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    scan_rows = conn.execute(
        "SELECT s.id, s.ts, s.checkpoint_id, s.decision, s.reason, s.offline,"
        " b.code, b.zone_id, b.plate, b.vtype"
        " FROM scan_events s LEFT JOIN bookings b ON b.id = s.booking_id"
        " ORDER BY s.ts DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()

    feed = []
    for r in admin_rows:
        d = dict(r)
        feed.append({
            "id": f"a{d['id']}",
            "ts": d["ts"],
            "actor": d["actor"] or "system",
            "action": d["action"],
            "category": (d["action"] or "").split(".")[0] or "system",
            "detail": d["detail"] or "",
            "offline": False,
        })
    for r in scan_rows:
        d = dict(r)
        veh = " ".join(x for x in (d.get("vtype"), d.get("plate")) if x)
        zone = f" · {d['zone_id']}" if d.get("zone_id") else ""
        detail = f"pass {d.get('code') or '—'}{zone}"
        if veh:
            detail += f" ({veh})"
        if d.get("reason"):
            detail += f" — {d['reason']}"
        feed.append({
            "id": f"s{d['id']}",
            "ts": d["ts"],
            "actor": d["checkpoint_id"],
            "action": f"gate.{d['decision']}",
            "category": "gate",
            "detail": detail,
            "offline": bool(d["offline"]),
        })

    feed.sort(key=lambda x: x["ts"], reverse=True)
    return feed[:limit]


# --------------------------------------------------------------------------- #
# Gate-operator account management (commander adds/removes operators)
# --------------------------------------------------------------------------- #
@app.get("/api/admin/operators")
def list_operators(principal: dict = Depends(staff_dep)):
    """All gate-operator accounts with their bound zone. Staff-visible."""
    conn = db.connect()
    rows = conn.execute(
        "SELECT u.id, u.display_name, u.zone_id, z.name AS zone_name,"
        " (s.subject IS NOT NULL) AS online"
        " FROM users u LEFT JOIN zones z ON z.id=u.zone_id"
        " LEFT JOIN sessions s ON s.subject=u.id"
        " WHERE u.role='operator' ORDER BY u.zone_id, u.id",
    ).fetchall()
    conn.close()
    return [{"username": r["id"], "display_name": r["display_name"],
             "zone_id": r["zone_id"], "zone_name": r["zone_name"],
             "online": bool(r["online"])} for r in rows]


class OperatorReq(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=256)
    display_name: str = Field(min_length=1, max_length=80)
    zone_id: str = Field(min_length=1, max_length=64)


@app.post("/api/admin/operators")
def add_operator(req: OperatorReq, commander: dict = Depends(commander_dep)):
    """Create a gate-operator login bound to a zone. Commander-only."""
    username = req.username.strip().lower()
    if not _USERNAME_RE.match(username):
        raise HTTPException(422, "username: letters/digits/._- only, min 3 chars")
    conn = db.connect()
    _require_zone(conn, req.zone_id)
    if conn.execute("SELECT 1 FROM users WHERE id=?", (username,)).fetchone():
        conn.close()
        raise HTTPException(409, "username already exists")
    h, s = auth.hash_password(req.password)
    conn.execute(
        "INSERT INTO users(id,pw_hash,pw_salt,role,display_name,zone_id)"
        " VALUES(?,?,?, 'operator', ?,?)",
        (username, h, s, req.display_name.strip(), req.zone_id),
    )
    audit(conn, commander["name"], "operator.add",
          f"{username} → {req.zone_id} ({req.display_name.strip()})")
    conn.commit()
    conn.close()
    return {"ok": True, "username": username, "zone_id": req.zone_id,
            "display_name": req.display_name.strip()}


@app.delete("/api/admin/operators/{username}")
def remove_operator(username: str, commander: dict = Depends(commander_dep)):
    """Delete a gate-operator account and kill any live session it holds."""
    username = username.strip().lower()
    conn = db.connect()
    u = conn.execute("SELECT role FROM users WHERE id=?", (username,)).fetchone()
    if not u:
        conn.close()
        raise HTTPException(404, "unknown operator")
    if u["role"] != "operator":
        conn.close()
        raise HTTPException(403, "only operator accounts can be removed here")
    conn.execute("DELETE FROM users WHERE id=?", (username,))
    conn.execute("DELETE FROM sessions WHERE subject=?", (username,))
    audit(conn, commander["name"], "operator.remove", username)
    conn.commit()
    conn.close()
    return {"ok": True, "removed": username}


# --------------------------------------------------------------------------- #
# Checkpoint node lifecycle — bring a zone's gate process up/down from the UI
#
# A demo convenience so the commander doesn't have to open a terminal and run
# scripts/run.sh by hand for every zone. Central spawns the SAME node process the
# script would (uvicorn node:app), on a port DETERMINISTICALLY derived from the
# zone's seed order — so indore→8001, dewas→8002, … exactly matching ZONES.md
# regardless of launch order. Commander-only (it spawns OS processes).
#
# Not for production: in the field each gate is its own Raspberry Pi, started by
# the device, not forked by central. This is purely to make the local demo
# one-click instead of one-terminal-per-zone.
# --------------------------------------------------------------------------- #
_CHECKPOINT_DIR = Path(__file__).resolve().parents[1] / "checkpoint"
_node_procs: dict[str, subprocess.Popen] = {}      # zones WE launched (killable)


def _zone_ids() -> list[str]:
    return [z[0] for z in db.SEED_ZONES]


def _zone_port(zone_id: str) -> int:
    """Fixed port per zone = 8001 + its index in seed order."""
    return 8001 + _zone_ids().index(zone_id)


def _port_open(port: int) -> bool:
    """True if something is listening on the loopback port — our truth for
    'running', so a gate started by run.sh counts too, not just ones we forked."""
    s = socket.socket()
    s.settimeout(0.25)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _node_state(zone_id: str) -> dict:
    port = _zone_port(zone_id)
    proc = _node_procs.get(zone_id)
    managed = bool(proc and proc.poll() is None)   # we own this process
    return {
        "zone_id": zone_id,
        "port": port,
        "base": f"http://127.0.0.1:{port}",
        "running": _port_open(port),
        "managed": managed,
    }


@app.get("/api/admin/nodes")
def nodes_list(principal: dict = Depends(staff_dep)):
    return {z: _node_state(z) for z in _zone_ids()}


@app.post("/api/admin/nodes/{zone_id}/up")
def node_up(zone_id: str, commander: dict = Depends(commander_dep)):
    if zone_id not in _zone_ids():
        raise HTTPException(404, "unknown zone")
    state = _node_state(zone_id)
    if state["running"]:
        return state                                # already up (ours or external)
    port = state["port"]
    env = {
        **os.environ,
        "ZONE_ID": zone_id,
        "CHECKPOINT_ID": f"cp-{zone_id}",
        "CENTRAL_URL": "http://127.0.0.1:8000",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "node:app",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=str(_CHECKPOINT_DIR), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    _node_procs[zone_id] = proc
    # Give uvicorn a moment to bind so the first status poll from the UI succeeds.
    for _ in range(40):
        if _port_open(port):
            break
        if proc.poll() is not None:                 # died (e.g. port clash)
            raise HTTPException(500, "gate process exited on startup")
        time.sleep(0.1)
    return _node_state(zone_id)


@app.post("/api/admin/nodes/{zone_id}/down")
def node_down(zone_id: str, commander: dict = Depends(commander_dep)):
    if zone_id not in _zone_ids():
        raise HTTPException(404, "unknown zone")
    proc = _node_procs.get(zone_id)
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        _node_procs.pop(zone_id, None)
        return _node_state(zone_id)
    # Running but not ours (started by run.sh / externally) — we won't kill it.
    if _port_open(_zone_port(zone_id)):
        raise HTTPException(
            409, "gate is running but was not started here — stop it where it was launched")
    _node_procs.pop(zone_id, None)
    return _node_state(zone_id)


@app.on_event("shutdown")
def _stop_managed_nodes():
    for proc in _node_procs.values():
        if proc.poll() is None:
            proc.terminate()


# --------------------------------------------------------------------------- #
# Parking visualisation — BookMyShow-style spot map for the command centre
# --------------------------------------------------------------------------- #
@app.get("/api/admin/parking")
def admin_parking(date: str, principal: dict = Depends(staff_dep)):
    """Per-zone, per-lot spot breakdown for the visual parking map. Each lot returns
    its actual occupants (arrived vehicles — split into parked-as-booked vs moved
    here) and its reservations (booked, not yet arrived), so the UI can render a
    seat-grid coloured by state. Date-scoped via the slot."""
    _valid_date(date)
    conn = db.connect()
    zones_out = []
    for z in conn.execute("SELECT * FROM zones ORDER BY id").fetchall():
        lots_out = []
        for lot in _zone_lots(conn, z["id"]):
            arrived = conn.execute(
                "SELECT b.code, b.vtype, b.plate, b.lot_id"
                " FROM bookings b JOIN slots s ON s.id=b.slot_id"
                " WHERE b.assigned_lot=? AND b.status='arrived' AND s.date=?"
                " ORDER BY b.updated_at",
                (lot["id"], date),
            ).fetchall()
            reserved = conn.execute(
                "SELECT b.code, b.vtype"
                " FROM bookings b JOIN slots s ON s.id=b.slot_id"
                " WHERE b.lot_id=? AND b.status='booked' AND s.date=?"
                " ORDER BY b.created_at",
                (lot["id"], date),
            ).fetchall()
            occupants = []
            for r in arrived:
                moved = bool(r["lot_id"]) and r["lot_id"] != lot["id"]
                occupants.append({
                    "code": r["code"], "vtype": r["vtype"],
                    "last4": tickets.plate_last4(r["plate"]),
                    "status": "reassigned" if moved else "parked",
                })
            lots_out.append({
                "id": lot["id"], "name": lot["name"],
                "capacity": lot["capacity"], "cascade_ord": lot["cascade_ord"],
                "primary": lot["cascade_ord"] == 0,
                "occupants": occupants,
                "reserved": [{"code": r["code"], "vtype": r["vtype"]} for r in reserved],
            })
        zones_out.append({
            "id": z["id"], "name": z["name"],
            "locked": _active_lockdown_scope(conn, z["id"]) is not None,
            "lots": lots_out,
        })
    conn.close()
    return {"date": date, "zones": zones_out}


# --------------------------------------------------------------------------- #
# Batch sync for checkpoint nodes (push logs, pull snapshot)
# --------------------------------------------------------------------------- #
@app.get("/api/public_key")
def public_key():
    return {"public_key_b64": base64.b64encode(
        tickets.PUBLIC_KEY_PATH.read_bytes()).decode("ascii")}


def _snapshot(conn, zone_id: str, since: str | None = None) -> dict:
    """Snapshot for a node. With `since` (the node's last cursor) only bookings
    changed after it are returned — a true delta (C12); the node upserts them
    instead of replacing its whole cache. Lockdowns + lots are small, sent in full.
    `cursor` is the high-water mark the node stores for next time."""
    if since:
        rows = conn.execute(
            "SELECT id,slot_id,zone_id,vtype,vcount,status,code,slot_type,plate,vdesc,"
            "lot_id,assigned_lot,updated_at FROM bookings"
            " WHERE zone_id=? AND updated_at > ?", (zone_id, since),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id,slot_id,zone_id,vtype,vcount,status,code,slot_type,plate,vdesc,"
            "lot_id,assigned_lot,updated_at FROM bookings WHERE zone_id=?",
            (zone_id,),
        ).fetchall()
    cursor = conn.execute(
        "SELECT MAX(updated_at) AS m FROM bookings WHERE zone_id=?", (zone_id,),
    ).fetchone()["m"] or since or ""
    lockdowns = conn.execute(
        "SELECT scope,active,reason FROM lockdowns"
        " WHERE active=1 AND scope IN ('ALL', ?)", (zone_id,),
    ).fetchall()
    lots = _zone_lots(conn, zone_id)
    return {
        "zone_id": zone_id,
        "server_time": now_iso(),
        "cursor": cursor,
        "delta": since is not None,
        "plate_secret": tickets.plate_secret_b64(),  # for offline plate-hash verify
        "bookings": [dict(b) for b in rows],
        "lockdowns": [dict(l) for l in lockdowns],
        "lots": [dict(l) for l in lots],
    }


@app.get("/api/sync/snapshot")
def sync_snapshot(zone_id: str, node: dict = Depends(node_dep)):
    conn = db.connect()
    snap = _snapshot(conn, zone_id)
    conn.close()
    return snap


class ScanEvent(BaseModel):
    id: str
    booking_id: str | None = None
    decision: str
    reason: str = ""
    offline: bool = False
    ts: str


class AssignEvent(BaseModel):
    id: str
    booking_id: str | None = None
    action: str
    from_lot: str | None = None
    to_lot: str | None = None
    reason: str = ""
    ts: str


class SyncLogsReq(BaseModel):
    checkpoint_id: str
    zone_id: str
    since: str | None = None        # node's delta cursor (last updated_at applied)
    events: list[ScanEvent] = []
    assignments: list[AssignEvent] = []


@app.post("/api/sync/logs")
def sync_logs(req: SyncLogsReq, node: dict = Depends(node_dep)):
    """Checkpoint uploads its local scan log + assignment events; we ingest both
    idempotently and return a fresh snapshot. Authenticated by the per-node token
    (docs/AUDIT.md — sync ingest must not accept forged events)."""
    conn = db.connect()
    ingested = 0
    for e in req.events:
        exists = conn.execute(
            "SELECT 1 FROM scan_events WHERE id=?", (e.id,)
        ).fetchone()
        if exists:
            continue
        conn.execute(
            "INSERT INTO scan_events(id,booking_id,checkpoint_id,decision,reason,"
            "offline,ts) VALUES(?,?,?,?,?,?,?)",
            (e.id, e.booking_id, req.checkpoint_id, e.decision, e.reason,
             1 if e.offline else 0, e.ts),
        )
        # Reconcile booking status: an admit marks the vehicle arrived; a gate-out
        # exit marks it departed, freeing its physical space (C5).
        if e.decision == "admit" and e.booking_id:
            conn.execute(
                "UPDATE bookings SET status='arrived', updated_at=?"
                " WHERE id=? AND status IN ('booked','noshow')",
                (now_iso(), e.booking_id),
            )
        elif e.decision == "exit" and e.booking_id:
            conn.execute(
                "UPDATE bookings SET status='departed', updated_at=?"
                " WHERE id=? AND status='arrived'",
                (now_iso(), e.booking_id),
            )
        ingested += 1

    # Ingest the mutable assignment layer (§9). Idempotent on event id; the latest
    # event per booking sets bookings.assigned_lot (the lot the vehicle went to).
    assigned = 0
    for a in req.assignments:
        if conn.execute("SELECT 1 FROM assignment_events WHERE id=?", (a.id,)).fetchone():
            continue
        conn.execute(
            "INSERT INTO assignment_events(id,booking_id,zone_id,checkpoint_id,"
            "action,from_lot,to_lot,reason,ts) VALUES(?,?,?,?,?,?,?,?,?)",
            (a.id, a.booking_id, req.zone_id, req.checkpoint_id, a.action,
             a.from_lot, a.to_lot, a.reason, a.ts),
        )
        if a.booking_id and a.to_lot:
            conn.execute("UPDATE bookings SET assigned_lot=? WHERE id=?",
                         (a.to_lot, a.booking_id))
        assigned += 1

    conn.execute(
        "UPDATE checkpoints SET last_sync=? WHERE id=?",
        (now_iso(), req.checkpoint_id),
    )
    audit(conn, req.checkpoint_id, "sync.logs",
          f"ingested={ingested} assignments={assigned}")
    snap = _snapshot(conn, req.zone_id, since=req.since)
    conn.commit()
    conn.close()
    return {"ingested": ingested, "assignments": assigned, "snapshot": snap}


# --------------------------------------------------------------------------- #
# Cloud mirror (MongoDB) — status + manual sync trigger for the demo.
# The mirror also runs automatically on a background timer; these endpoints let
# the command centre SEE it working and force a push during the pitch.
# --------------------------------------------------------------------------- #
@app.get("/api/admin/mongo/status")
def mongo_status(principal: dict = Depends(staff_dep)):
    """Is the cloud mirror on, reachable, and when did it last sync."""
    return mongo_sync.status()


@app.post("/api/admin/mongo/sync")
def mongo_sync_now(commander: dict = Depends(commander_dep)):
    """Force a batch push to MongoDB now (local SQLite → cloud). Best-effort:
    returns per-collection counts, or an error blob if the cloud is unreachable —
    the local system keeps working either way."""
    if not mongo_sync.enabled():
        raise HTTPException(400, "cloud mirror disabled — set MONGO_URI in .env")
    result = mongo_sync.sync_once()
    conn = db.connect()
    audit(conn, commander["name"], "mongo.sync",
          f"pushed={result.get('pushed', 0)} error={result.get('error')}")
    conn.commit()
    conn.close()
    return result


# --------------------------------------------------------------------------- #
# Serve the built React frontend (Section 11: FastAPI serves dist/)
# --------------------------------------------------------------------------- #
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/")
    def _index():
        return FileResponse(FRONTEND_DIST / "index.html")

    # SPA client-side routes (e.g. /operator/scan) — serve index.html so deep
    # links and browser back/forward work when central serves the built frontend.
    # The API/doc routes above are matched first; this only catches leftovers, and
    # guards so an unknown /api/* path still 404s instead of returning HTML.
    @app.get("/{full_path:path}")
    def _spa(full_path: str):
        if (full_path.startswith(("api/", "assets/"))
                or full_path in ("docs", "redoc", "openapi.json")):
            raise HTTPException(404, "not found")
        return FileResponse(FRONTEND_DIST / "index.html")
