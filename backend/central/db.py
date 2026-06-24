"""
Central command database (SQLite). This is the source of truth for zones, slots,
bookings, lockdowns and the reconciliation audit log. In production this would be
Postgres on the Smart City cloud; SQLite keeps the prototype dependency-free.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shared import auth  # noqa: E402

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "central.db"

# Ujjain approach-road entry zones (Section 2 of the brief). Each real-world zone
# is self-contained with its own parking; here each maps to one checkpoint road.
SEED_ZONES = [
    ("indore", "Zone 1 — Indore Road", "Indore Road", 75.40, 23.13),
    ("dewas", "Zone 2 — Dewas Road", "Dewas Road", 75.81, 23.20),
    ("unhel", "Zone 3 — Unhel Road", "Unhel Road", 75.72, 23.27),
    ("badnagar", "Zone 4 — Badnagar Road", "Badnagar Road", 75.66, 23.23),
    ("agar", "Zone 5 — Agar Road", "Agar Road", 75.86, 23.25),
    ("maksi", "Zone 6 — Maksi Road", "Maksi Road", 75.90, 23.18),
    ("ramghat", "Zone 7 — Ramghat Approach", "Ramghat Marg", 75.77, 23.18),
]

# Demo event days. Convert relative dates to absolute (brief: Simhastha 2028).
SEED_DATES = ["2028-04-27", "2028-04-28", "2028-05-09"]

# Arrival windows, BookMyShow-style "showtimes".
SEED_SLOTS = [
    ("06:00", "07:00"),
    ("07:00", "08:00"),
    ("08:00", "09:00"),
    ("09:00", "10:00"),
    ("10:00", "11:00"),
    ("11:00", "12:00"),
]

# Physical parking lots per zone, in OVERFLOW CASCADE order (Kumbh 2025 model:
# "park at lot A; if full → B, C"). cascade_ord 0 = primary. Physical capacities
# are scaled DOWN for the demo so overflow is reachable in a few gate admits; in
# the field these are the real lot sizes. See docs/DESIGN-v2.md §9.
SEED_LOTS = {
    "indore":   [("P1 — Sugar Mill",   4), ("P2 — Pure Surdas", 4), ("P3 — Bypass Ground", 80)],
    "dewas":    [("P1 — Nehru Park",   4), ("P2 — Mill Yard",   4), ("P3 — Ring Road Maidan", 70)],
    "unhel":    [("P1 — Mandi Ground", 3), ("P2 — School Field", 3), ("P3 — Canal Bank", 50)],
    "badnagar": [("P1 — Bus Stand",    3), ("P2 — Krishi Upaj",  3), ("P3 — Outer Field", 60)],
    "agar":     [("P1 — Tehsil Ground", 3), ("P2 — Stadium",     3), ("P3 — Highway Strip", 55)],
    "maksi":    [("P1 — Station Lot",  3), ("P2 — Old Mandi",    3), ("P3 — River Flats", 40)],
    "ramghat":  [("P1 — Ghat Marg",    3), ("P2 — Temple Annexe", 3), ("P3 — Walk-in Field", 35)],
}


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = connect()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS zones (
            id        TEXT PRIMARY KEY,
            name      TEXT NOT NULL,
            road      TEXT NOT NULL,
            lng       REAL NOT NULL,
            lat       REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS slots (
            id        TEXT PRIMARY KEY,
            zone_id   TEXT NOT NULL REFERENCES zones(id),
            date      TEXT NOT NULL,
            start     TEXT NOT NULL,
            end       TEXT NOT NULL,
            capacity  INTEGER NOT NULL,
            slot_type TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'vip'
            UNIQUE(zone_id, date, start, slot_type)
        );

        CREATE TABLE IF NOT EXISTS bookings (
            id         TEXT PRIMARY KEY,
            slot_id    TEXT NOT NULL REFERENCES slots(id),
            zone_id    TEXT NOT NULL REFERENCES zones(id),
            vtype      TEXT NOT NULL,         -- '2w' | 'car' | 'bus' | 'emergency'
            vcount     INTEGER NOT NULL DEFAULT 1,
            plate      TEXT,                  -- normalized plate, bound into signed QR
            vdesc      TEXT,                  -- free text colour/model, aids gate check
            lot_id        TEXT,               -- intended (booked) parking lot; NOT signed
            assigned_lot  TEXT,               -- actual lot the gate sent them to (from events)
            phone         TEXT,               -- booker identity (anti-tout caps, retrieval)
            status     TEXT NOT NULL DEFAULT 'booked', -- booked|arrived|revoked|noshow
            code       TEXT NOT NULL,
            token      TEXT NOT NULL,
            slot_type  TEXT NOT NULL DEFAULT 'public',
            created_at TEXT NOT NULL,
            updated_at TEXT             -- bumped on every status change (delta-sync cursor)
        );

        CREATE TABLE IF NOT EXISTS lots (
            id          TEXT PRIMARY KEY,      -- e.g. 'indore-1'
            zone_id     TEXT NOT NULL REFERENCES zones(id),
            name        TEXT NOT NULL,
            capacity    INTEGER NOT NULL,      -- physical spaces
            cascade_ord INTEGER NOT NULL,      -- overflow order within zone (0 = primary)
            lat         REAL,
            lng         REAL
        );

        -- The mutable assignment layer (docs/DESIGN-v2.md §9): append-only, one row
        -- per gate decision. Ingested idempotently from nodes at sync. The signed
        -- pass is never edited; the lot a vehicle actually went to lives only here.
        CREATE TABLE IF NOT EXISTS assignment_events (
            id            TEXT PRIMARY KEY,    -- uuid generated at the node
            booking_id    TEXT,
            zone_id       TEXT,
            checkpoint_id TEXT,
            action        TEXT NOT NULL,       -- assign | overflow_redirect | manual_reassign
            from_lot      TEXT,
            to_lot        TEXT,
            reason        TEXT,
            ts            TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
            id         TEXT PRIMARY KEY,
            zone_id    TEXT NOT NULL REFERENCES zones(id),
            name       TEXT NOT NULL,
            token      TEXT,                 -- per-node sync secret (authenticates sync)
            last_sync  TEXT
        );

        -- Staff identities (commander / dispatcher / operator). Citizens are NOT
        -- here — they authenticate by phone-OTP and carry a lighter token.
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,    -- username
            pw_hash       TEXT NOT NULL,
            pw_salt       TEXT NOT NULL,
            role          TEXT NOT NULL,       -- commander | dispatcher | operator
            display_name  TEXT NOT NULL,
            zone_id       TEXT                 -- operators are bound to a zone
        );

        -- Mock OTP store for citizen phone verification (prototype; a real SMS
        -- gateway drops in behind /api/auth/otp/request).
        CREATE TABLE IF NOT EXISTS otp_codes (
            phone     TEXT PRIMARY KEY,
            code      TEXT NOT NULL,
            expires   TEXT NOT NULL,
            attempts  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS lockdowns (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            scope      TEXT NOT NULL,          -- zone id, or 'ALL'
            active     INTEGER NOT NULL DEFAULT 1,
            reason     TEXT,
            actor      TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            ts         TEXT NOT NULL,
            actor      TEXT,
            action     TEXT NOT NULL,
            detail     TEXT
        );

        -- decisions uploaded from checkpoint nodes during batch sync
        CREATE TABLE IF NOT EXISTS scan_events (
            id            TEXT PRIMARY KEY,    -- uuid generated at the node
            booking_id    TEXT,
            checkpoint_id TEXT,
            decision      TEXT NOT NULL,       -- admit | deny
            reason        TEXT,
            offline       INTEGER NOT NULL DEFAULT 0,
            ts            TEXT NOT NULL
        );
        """
    )
    _migrate(conn)
    conn.commit()
    _seed(conn)
    _seed_lots(conn)
    _seed_users(conn)
    conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after a DB was first created. Idempotent: only adds
    a column when it is absent, so existing prototype DBs upgrade in place."""
    have = {r["name"] for r in conn.execute("PRAGMA table_info(bookings)").fetchall()}
    for col in ("vdesc", "lot_id", "assigned_lot", "phone", "revoked_by", "updated_at"):
        if col not in have:
            conn.execute(f"ALTER TABLE bookings ADD COLUMN {col} TEXT")
    # Backfill updated_at so the first delta sync has a cursor baseline.
    conn.execute("UPDATE bookings SET updated_at=created_at WHERE updated_at IS NULL")
    cp = {r["name"] for r in conn.execute("PRAGMA table_info(checkpoints)").fetchall()}
    if "token" not in cp:
        conn.execute("ALTER TABLE checkpoints ADD COLUMN token TEXT")


def _seed(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    if cur.execute("SELECT COUNT(*) FROM zones").fetchone()[0] > 0:
        return

    for zid, name, road, lng, lat in SEED_ZONES:
        cur.execute(
            "INSERT INTO zones(id,name,road,lng,lat) VALUES(?,?,?,?,?)",
            (zid, name, road, lng, lat),
        )

    # Per-zone capacities differ so the dashboard shows variety.
    base_cap = {"indore": 120, "dewas": 100, "unhel": 60, "badnagar": 80,
                "agar": 70, "maksi": 50, "ramghat": 40}
    for zid, *_ in SEED_ZONES:
        for date in SEED_DATES:
            for start, end in SEED_SLOTS:
                cur.execute(
                    "INSERT INTO slots(id,zone_id,date,start,end,capacity,slot_type)"
                    " VALUES(?,?,?,?,?,?, 'public')",
                    (f"{zid}-{date}-{start}", zid, date, start, end, base_cap[zid]),
                )
                # Small reserved VIP block per slot (Section 7: same primitive).
                cur.execute(
                    "INSERT INTO slots(id,zone_id,date,start,end,capacity,slot_type)"
                    " VALUES(?,?,?,?,?,?, 'vip')",
                    (f"{zid}-{date}-{start}-vip", zid, date, start, end, 10),
                )

    # One checkpoint node per zone (the node process registers itself too).
    # Deterministic demo sync token per node; overridable via the node's NODE_TOKEN.
    for zid, name, road, *_ in SEED_ZONES:
        cur.execute(
            "INSERT INTO checkpoints(id,zone_id,name,token,last_sync) VALUES(?,?,?,?,NULL)",
            (f"cp-{zid}", zid, f"{road} Checkpoint", f"node-{zid}-secret"),
        )

    conn.commit()


# Demo staff accounts. Two commanders so the two-person lockdown-LIFT rule is
# demoable on one machine; a dispatcher who may issue emergency passes; one
# operator per zone. Passwords are intentionally simple for the pitch demo and
# surfaced in the login UI — rotate before any real deployment.
DEMO_PASSWORD = "simhastha28"
SEED_USERS = [
    ("commander.a", "commander", "Cmdr. A. Sharma (Command)", None),
    ("commander.b", "commander", "Cmdr. B. Verma (Command)", None),
    ("dispatcher",  "dispatcher", "Emergency Dispatcher", None),
]


def _seed_users(conn: sqlite3.Connection) -> None:
    """Seed staff identities idempotently (independent of _seed so existing DBs
    gain accounts on upgrade)."""
    cur = conn.cursor()
    if cur.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
        return
    rows = list(SEED_USERS)
    for zid, *_ in SEED_ZONES:  # one operator per zone
        rows.append((f"op.{zid}", "operator", f"{zid.title()} Gate Operator", zid))
    for username, role, name, zone in rows:
        h, s = auth.hash_password(DEMO_PASSWORD)
        cur.execute(
            "INSERT INTO users(id,pw_hash,pw_salt,role,display_name,zone_id)"
            " VALUES(?,?,?,?,?,?)",
            (username, h, s, role, name, zone),
        )
    conn.commit()


def _seed_lots(conn: sqlite3.Connection) -> None:
    """Seed physical lots in cascade order. Idempotent + independent of _seed so
    an already-seeded prototype DB still gains lots on upgrade."""
    cur = conn.cursor()
    if cur.execute("SELECT COUNT(*) FROM lots").fetchone()[0] > 0:
        return
    # Spread the 3 lots slightly around each zone's coordinate for the map.
    zone_xy = {zid: (lng, lat) for zid, _n, _r, lng, lat in SEED_ZONES}
    for zid, lots in SEED_LOTS.items():
        base_lng, base_lat = zone_xy.get(zid, (75.77, 23.18))
        for ord_, (name, cap) in enumerate(lots):
            cur.execute(
                "INSERT INTO lots(id,zone_id,name,capacity,cascade_ord,lng,lat)"
                " VALUES(?,?,?,?,?,?,?)",
                (f"{zid}-{ord_+1}", zid, name, cap, ord_,
                 base_lng + ord_ * 0.004, base_lat + ord_ * 0.003),
            )
    conn.commit()
