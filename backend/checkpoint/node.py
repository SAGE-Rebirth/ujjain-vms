"""
Checkpoint Node (FastAPI) — runs at a single zone's entry road.

This is the part that MUST survive zero internet indefinitely (brief Section 6).
It holds:
  * the central PUBLIC key  -> verify any ticket signature offline
  * a local cache of bookings (pulled during the last sync window)
  * its own append-only scan log (SQLite), never lost if the link never returns

A real "network ON/OFF" switch cuts the link to central. With the link down the
node still admits/denies from local state. When the link returns, /sync does a
BATCH push-logs / pull-snapshot (FASTag-style), not a per-vehicle live call.

Run one process per zone:
    ZONE_ID=indore CHECKPOINT_ID=cp-indore PORT=8001 \
        uvicorn node:app --port 8001
"""
from __future__ import annotations

import os
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared import tickets  # noqa: E402

ZONE_ID = os.environ.get("ZONE_ID", "indore")
CHECKPOINT_ID = os.environ.get("CHECKPOINT_ID", f"cp-{ZONE_ID}")
CENTRAL_URL = os.environ.get("CENTRAL_URL", "http://127.0.0.1:8000")
# Per-node sync secret. Matches the deterministic demo seed in central/db.py;
# override per node in production. Authenticates this node to /api/sync/logs.
NODE_TOKEN = os.environ.get("NODE_TOKEN", f"node-{ZONE_ID}-secret")

# Arrival-window enforcement (deny tickets scanned outside their slot window).
# OFF by default so the Simhastha-2028-dated demo data verifies today; the
# capability exists and is unit-testable. Turn on with ENFORCE_WINDOW=1.
ENFORCE_WINDOW = os.environ.get("ENFORCE_WINDOW", "0") == "1"
WINDOW_GRACE_MIN = int(os.environ.get("WINDOW_GRACE_MIN", "120"))
DB_PATH = (Path(__file__).resolve().parents[2] / "data"
           / f"checkpoint_{ZONE_ID}.db")

app = FastAPI(title=f"Ujjain VMS — Checkpoint {ZONE_ID}")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    # WAL keeps the gate responsive: a verify-write never blocks a concurrent
    # status read, and busy_timeout rides out the brief sync write burst.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init_db() -> None:
    conn = connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS cached_bookings (
            id        TEXT PRIMARY KEY,
            zone_id   TEXT,
            code      TEXT,
            vtype     TEXT,
            status    TEXT,          -- booked|arrived|revoked|noshow (last synced)
            slot_type TEXT,
            plate     TEXT,          -- bound vehicle plate (for the code path)
            vdesc     TEXT           -- colour/model, shown to the operator
        );
        CREATE TABLE IF NOT EXISTS cached_lockdowns (
            scope  TEXT PRIMARY KEY,
            reason TEXT
        );
        -- Parking lots for this zone, in overflow-cascade order (synced config).
        CREATE TABLE IF NOT EXISTS cached_lots (
            id          TEXT PRIMARY KEY,
            zone_id     TEXT,
            name        TEXT,
            capacity    INTEGER,
            cascade_ord INTEGER,
            lat REAL, lng REAL
        );
        -- Physical occupancy this node OWNS (single owner in the prototype; the
        -- degenerate one-slice case of the escrow/bounded-counter model, §9.2).
        CREATE TABLE IF NOT EXISTS lot_occupancy (
            lot_id   TEXT PRIMARY KEY,
            consumed INTEGER NOT NULL DEFAULT 0
        );
        -- The mutable assignment layer: append-only, pushed to central at sync.
        CREATE TABLE IF NOT EXISTS assignment_events (
            id         TEXT PRIMARY KEY,
            booking_id TEXT,
            action     TEXT,        -- assign | overflow_redirect | manual_reassign
            from_lot   TEXT,
            to_lot     TEXT,
            reason     TEXT,
            synced     INTEGER DEFAULT 0,
            ts         TEXT
        );
        CREATE TABLE IF NOT EXISTS scan_log (
            id         TEXT PRIMARY KEY,
            booking_id TEXT,
            decision   TEXT,
            reason     TEXT,
            offline    INTEGER,
            synced     INTEGER DEFAULT 0,
            ts         TEXT
        );
        CREATE TABLE IF NOT EXISTS node_state (
            k TEXT PRIMARY KEY,
            v TEXT
        );
        """
    )
    # Defaults: network ON, manual deny-all OFF.
    for k, v in (("network", "on"), ("denyall", "off"),
                 ("last_sync", ""), ("pubkey_b64", ""),
                 ("time_floor", ""), ("plate_secret", ""), ("sync_cursor", "")):
        conn.execute("INSERT OR IGNORE INTO node_state(k,v) VALUES(?,?)", (k, v))
    # Migrate caches created before plate binding / lot assignment (idempotent).
    have = {r["name"] for r in
            conn.execute("PRAGMA table_info(cached_bookings)").fetchall()}
    for col in ("plate", "vdesc", "lot_id", "assigned_lot"):
        if col not in have:
            conn.execute(f"ALTER TABLE cached_bookings ADD COLUMN {col} TEXT")
    # Hot-path indexes for the offline decision (code lookup, parked-vehicle list,
    # unsynced-log scan). Created after the column migration so all refs exist.
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS ix_cached_code     ON cached_bookings(code);
        CREATE INDEX IF NOT EXISTS ix_cached_status   ON cached_bookings(status, assigned_lot);
        CREATE INDEX IF NOT EXISTS ix_scanlog_synced  ON scan_log(synced);
        CREATE INDEX IF NOT EXISTS ix_scanlog_ts      ON scan_log(ts);
        CREATE INDEX IF NOT EXISTS ix_assign_synced   ON assignment_events(synced);
        """
    )
    conn.commit()
    conn.close()
    _load_pubkey_from_disk()


def state_get(conn, k: str) -> str:
    row = conn.execute("SELECT v FROM node_state WHERE k=?", (k,)).fetchone()
    return row["v"] if row else ""


def state_set(conn, k: str, v: str) -> None:
    conn.execute("INSERT INTO node_state(k,v) VALUES(?,?)"
                 " ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))


def _load_pubkey_from_disk() -> None:
    """
    Provisioning shortcut for the demo: if the node and central share a disk,
    seed the public key from the .pub file. In the field this key is baked in
    at setup or fetched once over the first available link (see /sync).
    """
    conn = connect()
    if not state_get(conn, "pubkey_b64") and tickets.PUBLIC_KEY_PATH.exists():
        import base64
        state_set(conn, "pubkey_b64",
                  base64.b64encode(tickets.PUBLIC_KEY_PATH.read_bytes()).decode())
        conn.commit()
    conn.close()


def _public_key(conn) -> Ed25519PublicKey | None:
    import base64
    b64 = state_get(conn, "pubkey_b64")
    if not b64:
        return None
    return Ed25519PublicKey.from_public_bytes(base64.b64decode(b64))


@app.on_event("startup")
def _startup() -> None:
    init_db()


# --------------------------------------------------------------------------- #
# Operator controls
# --------------------------------------------------------------------------- #
class ToggleReq(BaseModel):
    on: bool


@app.post("/network")
def set_network(req: ToggleReq):
    conn = connect()
    state_set(conn, "network", "on" if req.on else "off")
    conn.commit()
    conn.close()
    return {"network": "on" if req.on else "off"}


@app.post("/denyall")
def set_denyall(req: ToggleReq):
    """Physical kill switch — works with NO system input at all (brief Section 6)."""
    conn = connect()
    state_set(conn, "denyall", "on" if req.on else "off")
    conn.commit()
    conn.close()
    return {"denyall": "on" if req.on else "off"}


@app.get("/status")
def status():
    conn = connect()
    cached = conn.execute("SELECT COUNT(*) AS n FROM cached_bookings").fetchone()["n"]
    pending = conn.execute(
        "SELECT COUNT(*) AS n FROM scan_log WHERE synced=0").fetchone()["n"]
    lockdowns = [dict(r) for r in
                 conn.execute("SELECT * FROM cached_lockdowns").fetchall()]
    out = {
        "zone_id": ZONE_ID,
        "checkpoint_id": CHECKPOINT_ID,
        "network": state_get(conn, "network"),
        "denyall": state_get(conn, "denyall"),
        "last_sync": state_get(conn, "last_sync") or None,
        "cached_bookings": cached,
        "pending_unsynced": pending,
        "cached_lockdowns": lockdowns,
        "has_pubkey": bool(state_get(conn, "pubkey_b64")),
    }
    conn.close()
    return out


@app.get("/log")
def get_log(limit: int = 25):
    limit = max(1, min(limit, 200))
    conn = connect()
    rows = conn.execute(
        "SELECT * FROM scan_log ORDER BY ts DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/lots")
def get_lots():
    """Lots in cascade order with locally-owned occupancy — drives the operator's
    lot view and the manual-reassign picker."""
    conn = connect()
    occ = _consumed(conn)
    out = []
    for l in _lots(conn):
        used = occ.get(l["id"], 0)
        out.append({
            "id": l["id"], "name": l["name"], "capacity": l["capacity"],
            "cascade_ord": l["cascade_ord"], "occupied": used,
            "available": max(l["capacity"] - used, 0),
            "full": used >= l["capacity"],
        })
    conn.close()
    return out


@app.get("/parked")
def parked():
    """Vehicles currently parked at this gate (admitted, not yet exited), with the
    lot each is in. Drives the 'reassign any parked vehicle later' operator screen —
    so a marshal can rebalance a vehicle long after its scan, not just on the admit
    result. Local + offline; the signed pass is never touched by a reassignment."""
    conn = connect()
    rows = conn.execute(
        "SELECT b.id, b.code, b.plate, b.vdesc, b.vtype, b.assigned_lot,"
        " l.name AS lot_name"
        " FROM cached_bookings b LEFT JOIN cached_lots l ON l.id=b.assigned_lot"
        " WHERE b.status='arrived' AND b.assigned_lot IS NOT NULL AND b.assigned_lot<>''"
        " ORDER BY l.cascade_ord, b.code"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


class ReassignReq(BaseModel):
    booking_id: str = Field(min_length=1, max_length=64)
    to_lot: str = Field(min_length=1, max_length=64)
    reason: str = Field(default="", max_length=200)


@app.post("/reassign")
def reassign(req: ReassignReq):
    """Operator manually moves a vehicle to a different lot (the 'they parked in
    P5 already' / 'P2 queue too long' case). Adjusts occupancy and appends a
    manual_reassign event. Works fully offline; the pass is never touched."""
    conn = connect()
    lot = conn.execute("SELECT * FROM cached_lots WHERE id=?", (req.to_lot,)).fetchone()
    if not lot:
        conn.close()
        raise HTTPException(404, "unknown lot")
    bk = conn.execute("SELECT * FROM cached_bookings WHERE id=?",
                      (req.booking_id,)).fetchone()
    from_lot = bk["assigned_lot"] if bk else None
    if from_lot == req.to_lot:
        conn.close()
        return {"ok": True, "unchanged": True, "lot_id": req.to_lot,
                "lot_name": lot["name"]}

    # Move one space off the old lot (if any) onto the new one. Marshal authority:
    # a manual move is allowed even if the target is at/over capacity (logged).
    if from_lot:
        conn.execute("UPDATE lot_occupancy SET consumed=MAX(consumed-1,0)"
                     " WHERE lot_id=?", (from_lot,))
    conn.execute("INSERT INTO lot_occupancy(lot_id,consumed) VALUES(?,1)"
                 " ON CONFLICT(lot_id) DO UPDATE SET consumed=consumed+1", (req.to_lot,))
    conn.execute("UPDATE cached_bookings SET assigned_lot=? WHERE id=?",
                 (req.to_lot, req.booking_id))
    conn.execute(
        "INSERT INTO assignment_events"
        "(id,booking_id,action,from_lot,to_lot,reason,synced,ts)"
        " VALUES(?,?, 'manual_reassign', ?,?,?,0,?)",
        (uuid.uuid4().hex, req.booking_id, from_lot, req.to_lot,
         req.reason or "operator override", now_iso()),
    )
    over = conn.execute("SELECT consumed FROM lot_occupancy WHERE lot_id=?",
                        (req.to_lot,)).fetchone()["consumed"]
    conn.commit()
    conn.close()
    return {"ok": True, "lot_id": req.to_lot, "lot_name": lot["name"],
            "from_lot": from_lot, "over_capacity": over > lot["capacity"]}


# --------------------------------------------------------------------------- #
# The 5-second admit/deny decision — OFFLINE CAPABLE
# --------------------------------------------------------------------------- #
class VerifyReq(BaseModel):
    token: str | None = Field(default=None, max_length=4096)  # full QR payload
    code: str | None = Field(default=None, max_length=16)     # 6-char operator fallback
    plate: str | None = Field(default=None, max_length=20)    # ANPR-read plate (camera)
    observed_plate: str | None = Field(default=None, max_length=20)  # plate seen on vehicle


def trusted_now(conn) -> datetime:
    """Clock the node trusts for expiry/window checks (docs/AUDIT.md C9).

    An offline Pi's wall clock can drift or be rolled BACK to revive an expired
    pass. Defence: a monotonic floor = the server time at the last sync. Even if the
    local clock is set to 2020, time is known to be ≥ that floor, so a pass that
    expired before the last sync stays expired. (A GPS/RTC module is the field fix.)"""
    now = datetime.now(timezone.utc)
    floor_s = state_get(conn, "time_floor")
    if floor_s:
        try:
            floor = datetime.fromisoformat(floor_s)
            if now < floor:
                return floor
        except (ValueError, TypeError):
            pass
    return now


def _within_window(date: str, ws: str, we: str, now: datetime) -> bool:
    """True if `now` is inside [start-grace, end+grace] for the slot window."""
    try:
        start = datetime.fromisoformat(f"{date}T{ws}:00+00:00")
        end = datetime.fromisoformat(f"{date}T{we}:00+00:00")
    except (ValueError, TypeError):
        return True  # unparseable -> don't block on a window we can't read
    grace = timedelta(minutes=WINDOW_GRACE_MIN)
    return start - grace <= now <= end + grace


def _expired(exp: str | None, now: datetime) -> bool:
    """Hard signed-expiry check against the trusted clock. Works OFFLINE with no
    cache — the cutoff is in the ticket itself. Absent/unparseable exp never blocks."""
    if not exp:
        return False
    try:
        return now > datetime.fromisoformat(exp)
    except (ValueError, TypeError):
        return False


def _lots(conn) -> list:
    return conn.execute(
        "SELECT * FROM cached_lots ORDER BY cascade_ord").fetchall()


def _consumed(conn) -> dict:
    return {r["lot_id"]: r["consumed"] for r in
            conn.execute("SELECT lot_id,consumed FROM lot_occupancy").fetchall()}


def _assign_lot(conn, booked_lot_id: str | None) -> dict | None:
    """Pick the lot to send the vehicle to, OFFLINE, against locally-owned counts.

    Tries the booked lot first; if physically full, walks the zone's cascade
    (Kumbh-style ordered overflow) to the first lot with room. Returns the
    assignment, or None when the WHOLE zone is full (caller denies). Returns a
    no-op {lot_id: None} when no lots are configured yet (degrade gracefully —
    never deny just because lot config hasn't synced)."""
    lots = _lots(conn)
    if not lots:
        return {"lot_id": None, "lot_name": None, "overflow_from": None}
    occ = _consumed(conn)
    by_id = {l["id"]: l for l in lots}

    def room(lot) -> bool:
        return occ.get(lot["id"], 0) < lot["capacity"]

    booked = by_id.get(booked_lot_id)
    if booked and room(booked):
        return {"lot_id": booked["id"], "lot_name": booked["name"], "overflow_from": None}
    # Overflow: first lot in cascade order with room (skip the full booked one).
    for lot in lots:
        if lot["id"] == booked_lot_id:
            continue
        if room(lot):
            return {"lot_id": lot["id"], "lot_name": lot["name"],
                    "overflow_from": booked_lot_id}
    return None  # zone-wide parking full


def _decide(conn, req: VerifyReq) -> dict:
    denyall = state_get(conn, "denyall") == "on"
    lockdowns = {r["scope"] for r in
                 conn.execute("SELECT scope FROM cached_lockdowns").fetchall()}
    locked = denyall or "ALL" in lockdowns or ZONE_ID in lockdowns

    tnow = trusted_now(conn)
    booking_id = None
    vtype = None
    stype = "public"
    expected_plate = ""   # FULL plate, only from the trusted local cache (display)
    plate_hash = ""       # keyed HMAC from the token (privacy; offline compare)
    plate_last = ""       # last-4, shown when the full plate isn't cached
    vdesc = ""
    cached = None

    # Resolve identity. Token path is fully offline (signature only).
    if req.token:
        pub = _public_key(conn)
        if pub is None:
            return {"decision": "deny", "reason": "no public key provisioned",
                    "booking_id": None}
        try:
            payload = tickets.verify_ticket(req.token, pub)
        except ValueError as exc:
            return {"decision": "deny", "reason": f"invalid ticket: {exc}",
                    "booking_id": None}
        booking_id = payload["bid"]
        vtype = payload.get("vt")
        stype = payload.get("st", "public")
        plate_hash = payload.get("ph", "")
        plate_last = payload.get("pl", "")
        vdesc = payload.get("vdesc", "")
        if payload.get("zone") != ZONE_ID:
            return {"decision": "deny",
                    "reason": f"wrong zone (ticket={payload.get('zone')})",
                    "booking_id": booking_id}
        if _expired(payload.get("exp"), tnow):
            return {"decision": "deny", "reason": "ticket expired",
                    "booking_id": booking_id, "plate_last": plate_last, "vdesc": vdesc}
        if ENFORCE_WINDOW and not _within_window(
                payload.get("date"), payload.get("ws"), payload.get("we"), tnow):
            return {"decision": "deny",
                    "reason": "outside arrival window",
                    "booking_id": booking_id, "plate_last": plate_last, "vdesc": vdesc}
        cached = conn.execute(
            "SELECT * FROM cached_bookings WHERE id=?", (booking_id,)).fetchone()
        if cached:                       # synced gate can show the real plate
            expected_plate = cached["plate"] or ""
    elif req.code:
        cached = conn.execute(
            "SELECT * FROM cached_bookings WHERE code=?",
            (req.code.strip().upper(),)).fetchone()
        if not cached:
            return {"decision": "deny",
                    "reason": "code not in local cache (sync needed)",
                    "booking_id": None}
        booking_id = cached["id"]
        vtype = cached["vtype"]
        stype = cached["slot_type"]
        expected_plate = cached["plate"] or ""
        plate_last = tickets.plate_last4(expected_plate)
        vdesc = cached["vdesc"] or ""
        if cached["zone_id"] != ZONE_ID:
            return {"decision": "deny", "reason": "wrong zone",
                    "booking_id": booking_id}
    elif req.plate:
        # ANPR path — the camera read a plate; resolve the booking by matching it
        # against the locally-cached plates for THIS zone. Fully offline: the plate
        # came down at the last sync, same trust model as the code path. On no match
        # the caller falls back to QR / manual code (plate_unmatched signals the UI).
        target = tickets.normalize_plate(req.plate)
        if not target:
            return {"decision": "deny", "reason": "no plate read", "booking_id": None,
                    "plate_unmatched": True}
        rows = conn.execute(
            "SELECT * FROM cached_bookings WHERE zone_id=?", (ZONE_ID,)).fetchall()
        matches = [r for r in rows
                   if tickets.normalize_plate(r["plate"]) == target]
        if not matches:
            return {"decision": "deny",
                    "reason": "plate not in local cache — scan QR or type code",
                    "booking_id": None, "plate_unmatched": True,
                    "observed_plate": target}
        # Prefer a live (un-arrived) pass so a plate maps to the entry, not a spent
        # one; a duplicate/departed match still resolves and the status checks below
        # produce the right "already used / already exited" deny.
        rank = {"booked": 0, "": 0, "arrived": 1, "departed": 2}
        cached = sorted(matches, key=lambda r: rank.get(r["status"], 3))[0]
        booking_id = cached["id"]
        vtype = cached["vtype"]
        stype = cached["slot_type"]
        # Normalized so the binding check below can't false-deny on spacing.
        expected_plate = tickets.normalize_plate(cached["plate"])
        plate_last = tickets.plate_last4(expected_plate)
        vdesc = cached["vdesc"] or ""
    else:
        return {"decision": "deny", "reason": "no token, code or plate",
                "booking_id": None}

    # Vehicle binding (anti-transfer): the observed plate must match the pass.
    # Compared against the FULL plate if cached, else against the keyed HMAC from
    # the token — both fully offline, both privacy-preserving (the QR never carries
    # cleartext plate). A clone is useless on a different vehicle.
    # The ANPR read doubles as the observed plate — resolving a booking by plate
    # already proves the vehicle matches its pass, so binding is satisfied.
    observed = tickets.normalize_plate(req.observed_plate or req.plate)
    plate_secret = state_get(conn, "plate_secret") or None
    matched = None
    if observed:
        if expected_plate:
            matched = observed == expected_plate
        elif plate_hash and plate_secret:
            matched = tickets.plate_hash(observed, plate_secret) == plate_hash
    if matched is False:
        return {"decision": "deny", "reason": "plate mismatch — vehicle not on pass",
                "booking_id": booking_id, "plate": expected_plate,
                "plate_last": plate_last, "observed_plate": observed, "vdesc": vdesc}

    vehicle = {"plate": expected_plate, "plate_last": plate_last, "vdesc": vdesc}

    # Lockdown gate — emergency vehicles stay exempt (Kumbh 2025 precedent).
    if locked and vtype != "emergency":
        return {"decision": "deny",
                "reason": "LOCKDOWN active — all vehicles denied",
                "booking_id": booking_id, **vehicle}

    # Cache-based checks (duplicate / revoked).
    soft_green = False
    if cached:
        if cached["status"] in ("revoked", "cancelled"):
            return {"decision": "deny",
                    "reason": "booking cancelled" if cached["status"] == "cancelled" else "booking revoked",
                    "booking_id": booking_id, **vehicle}
        if cached["status"] == "departed":
            # Single-use pass: once the vehicle has exited, the pass is spent and
            # cannot re-enter (works offline from the local cache too).
            return {"decision": "deny", "reason": "already exited — pass used",
                    "booking_id": booking_id, **vehicle}
        if cached["status"] == "arrived":
            return {"decision": "deny", "reason": "already used (duplicate)",
                    "booking_id": booking_id, **vehicle}
    else:
        # Valid signature but booking not in local cache yet: it was made after
        # the last sync. We cannot check for duplicate use offline, so admit
        # tentatively ("soft green") and flag it for reconciliation at sync.
        soft_green = True

    # Lot assignment (§9). Emergency vehicles skip parking allocation entirely.
    assigned_lot = lot_name = overflow_from = None
    if vtype != "emergency":
        booked_lot = cached["lot_id"] if cached else None
        pick = _assign_lot(conn, booked_lot)
        if pick is None:
            return {"decision": "deny", "reason": "zone parking full — no lot available",
                    "booking_id": booking_id, **vehicle}
        assigned_lot = pick["lot_id"]
        lot_name = pick["lot_name"]
        overflow_from = pick["overflow_from"]

    # Plate considered checked when the observed plate matched, or there is no
    # plate binding at all; otherwise the human eyeball check is still owed.
    has_binding = bool(expected_plate or plate_hash or plate_last)
    plate_checked = matched is True or not has_binding
    reason = "admitted (soft-green: unseen since last sync)" if soft_green else "admitted"
    if overflow_from:
        reason += f" · OVERFLOW → {lot_name}"
    elif lot_name:
        reason += f" · park at {lot_name}"
    resolved_by = "plate" if req.plate else "code" if req.code else "token"
    return {"decision": "admit", "reason": reason, "booking_id": booking_id,
            "vtype": vtype, "stype": stype, "soft_green": soft_green,
            "plate_checked": plate_checked, "assigned_lot": assigned_lot,
            "lot_name": lot_name, "overflow": bool(overflow_from),
            "overflow_from": overflow_from, "resolved_by": resolved_by, **vehicle}


@app.post("/verify")
def verify(req: VerifyReq):
    conn = connect()
    offline = state_get(conn, "network") == "off"
    result = _decide(conn, req)

    # Mark arrived locally so a second scan is caught as duplicate even offline.
    # Preserve the real code/vtype/slot_type (deterministic code from booking id)
    # so the operator fallback-code path and lockdown emergency-exemption keep
    # working for a soft-green admit before the next full sync.
    if result["decision"] == "admit" and result["booking_id"]:
        bid = result["booking_id"]
        lot = result.get("assigned_lot")
        conn.execute(
            "INSERT INTO cached_bookings"
            "(id,zone_id,code,vtype,status,slot_type,plate,vdesc,assigned_lot)"
            " VALUES(?,?,?,?, 'arrived', ?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET status='arrived', assigned_lot=excluded.assigned_lot",
            (bid, ZONE_ID, tickets.human_code(bid), result.get("vtype") or "",
             result.get("stype") or "public", result.get("plate") or "",
             result.get("vdesc") or "", lot),
        )
        # Occupancy + the mutable assignment event (§9). One admit = one space.
        if lot:
            conn.execute(
                "INSERT INTO lot_occupancy(lot_id,consumed) VALUES(?,1)"
                " ON CONFLICT(lot_id) DO UPDATE SET consumed=consumed+1", (lot,))
            conn.execute(
                "INSERT INTO assignment_events"
                "(id,booking_id,action,from_lot,to_lot,reason,synced,ts)"
                " VALUES(?,?,?,?,?,?,0,?)",
                (uuid.uuid4().hex, bid,
                 "overflow_redirect" if result.get("overflow") else "assign",
                 result.get("overflow_from"), lot,
                 result["reason"], now_iso()),
            )

    conn.execute(
        "INSERT INTO scan_log(id,booking_id,decision,reason,offline,synced,ts)"
        " VALUES(?,?,?,?,?,0,?)",
        (uuid.uuid4().hex, result["booking_id"], result["decision"],
         result["reason"], 1 if offline else 0, now_iso()),
    )
    conn.commit()
    conn.close()
    result["offline"] = offline
    return result


@app.post("/exit")
def gate_exit(req: VerifyReq):
    """Register a vehicle LEAVING — frees its physical space so occupancy is a
    current count, not cumulative arrivals (docs/AUDIT.md C5). Works offline; the
    exit syncs up as a scan event that marks the booking 'departed' centrally."""
    conn = connect()
    # Resolve the booking: trust the signature for a token, else the cached code.
    bid = None
    if req.token:
        pub = _public_key(conn)
        try:
            bid = tickets.verify_ticket(req.token, pub)["bid"] if pub else None
        except ValueError:
            bid = None
    elif req.code:
        row = conn.execute("SELECT id FROM cached_bookings WHERE code=?",
                            (req.code.strip().upper(),)).fetchone()
        bid = row["id"] if row else None
    elif req.plate:
        # ANPR exit: match the read plate against parked (arrived) vehicles in-zone.
        target = tickets.normalize_plate(req.plate)
        rows = conn.execute(
            "SELECT id,plate FROM cached_bookings WHERE zone_id=? AND status='arrived'",
            (ZONE_ID,)).fetchall()
        m = [r for r in rows if tickets.normalize_plate(r["plate"]) == target]
        bid = m[0]["id"] if m else None
    if not bid:
        conn.close()
        raise HTTPException(404, "vehicle not recognised")

    row = conn.execute("SELECT * FROM cached_bookings WHERE id=?", (bid,)).fetchone()
    lot = row["assigned_lot"] if row else None
    if not row or row["status"] != "arrived" or not lot:
        conn.close()
        raise HTTPException(409, "no active parked vehicle for this pass")
    conn.execute("UPDATE lot_occupancy SET consumed=MAX(consumed-1,0) WHERE lot_id=?",
                 (lot,))
    conn.execute("UPDATE cached_bookings SET status='departed' WHERE id=?", (bid,))
    conn.execute(
        "INSERT INTO scan_log(id,booking_id,decision,reason,offline,synced,ts)"
        " VALUES(?,?, 'exit', 'vehicle departed — lot freed', ?,0,?)",
        (uuid.uuid4().hex, bid,
         1 if state_get(conn, "network") == "off" else 0, now_iso()),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "booking_id": bid, "freed_lot": lot}


# --------------------------------------------------------------------------- #
# Batch sync (only path that touches the network)
# --------------------------------------------------------------------------- #
@app.post("/sync")
def sync():
    conn = connect()
    if state_get(conn, "network") == "off":
        conn.close()
        raise HTTPException(409, "network OFF — cannot reach central")

    # 1) push our unsynced scan log + assignment events
    pending = conn.execute(
        "SELECT * FROM scan_log WHERE synced=0").fetchall()
    events = [{
        "id": r["id"], "booking_id": r["booking_id"], "decision": r["decision"],
        "reason": r["reason"], "offline": bool(r["offline"]), "ts": r["ts"],
    } for r in pending]
    pending_assign = conn.execute(
        "SELECT * FROM assignment_events WHERE synced=0").fetchall()
    assignments = [{
        "id": r["id"], "booking_id": r["booking_id"], "action": r["action"],
        "from_lot": r["from_lot"], "to_lot": r["to_lot"], "reason": r["reason"],
        "ts": r["ts"],
    } for r in pending_assign]

    try:
        headers = {"Authorization": f"Bearer {NODE_TOKEN}"}
        with httpx.Client(timeout=5.0) as client:
            # Provision the public key if we don't have it yet (public endpoint).
            if not state_get(conn, "pubkey_b64"):
                pk = client.get(f"{CENTRAL_URL}/api/public_key").json()
                state_set(conn, "pubkey_b64", pk["public_key_b64"])
            resp = client.post(
                f"{CENTRAL_URL}/api/sync/logs", headers=headers,
                json={"checkpoint_id": CHECKPOINT_ID, "zone_id": ZONE_ID,
                      "since": state_get(conn, "sync_cursor") or None,
                      "events": events, "assignments": assignments},
            )
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, OSError) as exc:
        conn.close()
        raise HTTPException(502, f"central unreachable: {exc}") from exc

    # 2) mark pushed events synced
    for r in pending:
        conn.execute("UPDATE scan_log SET synced=1 WHERE id=?", (r["id"],))
    for r in pending_assign:
        conn.execute("UPDATE assignment_events SET synced=1 WHERE id=?", (r["id"],))

    # 3) apply the pulled DELTA. Bookings are UPSERTed (only the changed ones arrive
    # when `since` is set); never deleted, since central only status-changes them.
    snap = data["snapshot"]
    for b in snap["bookings"]:
        conn.execute(
            "INSERT INTO cached_bookings"
            "(id,zone_id,code,vtype,status,slot_type,plate,vdesc,lot_id,assigned_lot)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(id) DO UPDATE SET status=excluded.status,"
            " assigned_lot=excluded.assigned_lot, plate=excluded.plate,"
            " vdesc=excluded.vdesc, lot_id=excluded.lot_id",
            (b["id"], b["zone_id"], b["code"], b["vtype"], b["status"],
             b["slot_type"], b.get("plate") or "", b.get("vdesc") or "",
             b.get("lot_id"), b.get("assigned_lot")),
        )
    # Trusted-time floor + plate-verify secret ride every sync.
    if snap.get("server_time"):
        state_set(conn, "time_floor", snap["server_time"])
    if snap.get("plate_secret"):
        state_set(conn, "plate_secret", snap["plate_secret"])
    if snap.get("cursor"):
        state_set(conn, "sync_cursor", snap["cursor"])
    # Lockdowns + lots are small → full replace each sync.
    conn.execute("DELETE FROM cached_lockdowns")
    for l in snap["lockdowns"]:
        conn.execute("INSERT INTO cached_lockdowns(scope,reason) VALUES(?,?)",
                     (l["scope"], l.get("reason", "")))
    # Pull lot config (cascade order, capacities).
    conn.execute("DELETE FROM cached_lots")
    for l in snap.get("lots", []):
        conn.execute(
            "INSERT INTO cached_lots(id,zone_id,name,capacity,cascade_ord,lat,lng)"
            " VALUES(?,?,?,?,?,?,?)",
            (l["id"], l["zone_id"], l["name"], l["capacity"], l["cascade_ord"],
             l.get("lat"), l.get("lng")),
        )
    # Re-derive occupancy from reconciled truth: one consumed space per arrived
    # booking, counted against the lot it was actually assigned to.
    conn.execute("DELETE FROM lot_occupancy")
    conn.execute(
        "INSERT INTO lot_occupancy(lot_id,consumed)"
        " SELECT assigned_lot, COUNT(*) FROM cached_bookings"
        " WHERE status='arrived' AND assigned_lot IS NOT NULL AND assigned_lot<>''"
        " GROUP BY assigned_lot")

    state_set(conn, "last_sync", now_iso())
    conn.commit()
    out = {
        "ok": True, "pushed": len(events), "pushed_assignments": len(assignments),
        "ingested": data.get("ingested", 0),
        "cached_bookings": len(snap["bookings"]),
        "cached_lockdowns": len(snap["lockdowns"]),
        "cached_lots": len(snap.get("lots", [])),
        "last_sync": state_get(conn, "last_sync"),
    }
    conn.close()
    return out
