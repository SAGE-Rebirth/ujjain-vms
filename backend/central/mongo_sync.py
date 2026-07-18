"""
Cloud mirror — MongoDB (Atlas) sync for the central command DB.

Design rule (brief Section 3): the cloud is an OPTIMISATION, not a dependency.
SQLite stays the LOCAL source of truth; every booking/scan/lockdown is written to
SQLite first and works with zero connectivity. This module opportunistically
MIRRORS that data up to MongoDB — the same "local-first, batch-sync-when-a-link-
appears" shape the checkpoint nodes already use against central.

How it works
------------
* A background thread wakes every MONGO_SYNC_INTERVAL seconds and pushes deltas.
* Growing tables (bookings, scan/assignment events, audit_log) sync by a cursor
  (updated_at / ts / id) so each pass only ships what changed — cheap and resumable.
* Small config tables (zones, slots, lots, pricing, checkpoints, lockdowns,
  payments) are upserted as a full snapshot each pass.
* If Mongo/the network is down, sync fails quietly and retries next tick — SQLite
  and the whole gate keep working. Never raises into the request path.

Secrets are NOT mirrored: the users table (password hashes), sessions and OTP
codes stay local-only, and per-node sync tokens are redacted from checkpoints.

Enable by setting MONGO_URI (an Atlas connection string) in .env — see .env.example.
Without it, this module is inert and the app behaves exactly as before.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from datetime import datetime, timezone

import db  # noqa: E402  (same sys.path shim as app.py — central/ on path)

try:
    from pymongo import MongoClient, UpdateOne, ReplaceOne
    from pymongo.errors import PyMongoError
    _HAVE_PYMONGO = True
except Exception:  # pragma: no cover - pymongo not installed
    MongoClient = None  # type: ignore
    UpdateOne = ReplaceOne = None  # type: ignore
    PyMongoError = Exception  # type: ignore
    _HAVE_PYMONGO = False


MONGO_URI = os.environ.get("MONGO_URI", "").strip()
MONGO_DB = os.environ.get("MONGO_DB", "ujjain_vms").strip() or "ujjain_vms"
SYNC_INTERVAL = int(os.environ.get("MONGO_SYNC_INTERVAL", "30"))
BATCH = int(os.environ.get("MONGO_SYNC_BATCH", "500"))


def reload_config() -> None:
    """Re-read env into module config. This module is imported before app.py loads
    .env, so the import-time snapshot above can miss MONGO_URI. start() calls this
    once .env is in os.environ so the mirror actually sees the connection string."""
    global MONGO_URI, MONGO_DB, SYNC_INTERVAL, BATCH
    MONGO_URI = os.environ.get("MONGO_URI", "").strip()
    MONGO_DB = os.environ.get("MONGO_DB", "ujjain_vms").strip() or "ujjain_vms"
    SYNC_INTERVAL = int(os.environ.get("MONGO_SYNC_INTERVAL", "30"))
    BATCH = int(os.environ.get("MONGO_SYNC_BATCH", "500"))

# Delta tables: only rows past the stored cursor are pushed each pass. `numeric`
# marks an integer cursor (audit_log.id) vs. an ISO-8601 string cursor.
DELTA_TABLES = [
    {"name": "bookings",          "cursor": "updated_at", "numeric": False},
    {"name": "scan_events",       "cursor": "ts",         "numeric": False},
    {"name": "assignment_events", "cursor": "ts",         "numeric": False},
    {"name": "audit_log",         "cursor": "id",         "numeric": True},
]

# Snapshot tables: small + mutable, re-upserted wholesale each pass. `key` builds
# the Mongo _id; `redact` drops secret columns before they leave the machine.
SNAPSHOT_TABLES = [
    {"name": "zones",       "key": lambda r: r["id"]},
    {"name": "slots",       "key": lambda r: r["id"]},
    {"name": "lots",        "key": lambda r: r["id"]},
    {"name": "pricing",     "key": lambda r: f"{r['slot_type']}:{r['vtype']}"},
    {"name": "checkpoints", "key": lambda r: r["id"], "redact": ["token"]},
    {"name": "lockdowns",   "key": lambda r: r["id"]},
    {"name": "payments",    "key": lambda r: r["order_id"]},
]

_client = None                       # lazily-created MongoClient singleton
_lock = threading.Lock()             # guards _client + a single in-flight sync
_thread: threading.Thread | None = None
_last: dict = {"ran": None, "ok": None, "error": None, "pushed": 0}


def enabled() -> bool:
    return bool(MONGO_URI) and _HAVE_PYMONGO


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_state_table() -> None:
    """Local cursor bookkeeping (which rows already reached the cloud). Lives in
    SQLite so a restart resumes exactly where it left off."""
    conn = db.connect()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mongo_sync_state ("
        " collection TEXT PRIMARY KEY, cursor TEXT, last_run TEXT)"
    )
    conn.commit()
    conn.close()


def _get_cursor(conn, name: str) -> str | None:
    row = conn.execute(
        "SELECT cursor FROM mongo_sync_state WHERE collection=?", (name,)
    ).fetchone()
    return row["cursor"] if row else None


def _set_cursor(conn, name: str, cursor: str) -> None:
    conn.execute(
        "INSERT INTO mongo_sync_state(collection,cursor,last_run) VALUES(?,?,?)"
        " ON CONFLICT(collection) DO UPDATE SET cursor=excluded.cursor,"
        " last_run=excluded.last_run",
        (name, str(cursor), _now()),
    )


def get_client():
    """Lazy MongoClient with short timeouts so a dead cloud link fails fast and
    never stalls the request thread. Returns None when disabled."""
    global _client
    if not enabled():
        return None
    if _client is None:
        _client = MongoClient(
            MONGO_URI,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            socketTimeoutMS=20000,
            appname="ujjain-vms-central",
        )
    return _client


def _clean(row: dict, redact: list[str] | None = None) -> dict:
    d = dict(row)
    for k in (redact or []):
        d.pop(k, None)
    d["_synced_at"] = _now()
    return d


def sync_once() -> dict:
    """Push all pending deltas + refresh snapshots. Best-effort: on any Mongo error
    it records the failure and returns without raising. Serialised by _lock so the
    background tick and a manual trigger can't overlap."""
    if not enabled():
        return {"enabled": False}
    with _lock:
        client = get_client()
        result = {"enabled": True, "collections": {}, "pushed": 0}
        try:
            client.admin.command("ping")             # fail fast if unreachable
            mdb = client[MONGO_DB]
            sconn = db.connect()
            try:
                for t in DELTA_TABLES:
                    n = _sync_delta(sconn, mdb, t)
                    result["collections"][t["name"]] = n
                    result["pushed"] += n
                for t in SNAPSHOT_TABLES:
                    n = _sync_snapshot(sconn, mdb, t)
                    result["collections"][t["name"]] = n
                    result["pushed"] += n
                sconn.commit()
            finally:
                sconn.close()
            _last.update(ran=_now(), ok=True, error=None, pushed=result["pushed"])
        except PyMongoError as exc:
            _last.update(ran=_now(), ok=False, error=str(exc))
            result["error"] = str(exc)
        return result


def _sync_delta(sconn, mdb, t: dict) -> int:
    name, cur_col, numeric = t["name"], t["cursor"], t["numeric"]
    last = _get_cursor(sconn, name)
    if numeric:
        last_val = int(last) if last is not None else -1
        rows = sconn.execute(
            f"SELECT * FROM {name} WHERE {cur_col} > ? ORDER BY {cur_col} LIMIT ?",
            (last_val, BATCH),
        ).fetchall()
    else:
        rows = sconn.execute(
            f"SELECT * FROM {name} WHERE {cur_col} > ? ORDER BY {cur_col} LIMIT ?"
            if last is not None else
            f"SELECT * FROM {name} ORDER BY {cur_col} LIMIT ?",
            ((last, BATCH) if last is not None else (BATCH,)),
        ).fetchall()
    if not rows:
        return 0
    ops = []
    newest = last
    for r in rows:
        doc = _clean(r)
        _id = doc.get("id") if doc.get("id") is not None else doc.get(cur_col)
        ops.append(ReplaceOne({"_id": _id}, {**doc, "_id": _id}, upsert=True))
        newest = r[cur_col]
    mdb[name].bulk_write(ops, ordered=False)
    _set_cursor(sconn, name, str(newest))
    return len(ops)


def _sync_snapshot(sconn, mdb, t: dict) -> int:
    name, key, redact = t["name"], t["key"], t.get("redact")
    rows = sconn.execute(f"SELECT * FROM {name}").fetchall()
    if not rows:
        return 0
    ops = []
    for r in rows:
        _id = key(r)
        doc = _clean(r, redact)
        ops.append(ReplaceOne({"_id": _id}, {**doc, "_id": _id}, upsert=True))
    mdb[name].bulk_write(ops, ordered=False)
    return len(ops)


def status() -> dict:
    """Small health blob for the admin UI: is the mirror on, is the cloud reachable,
    and when did it last run. Never raises."""
    out = {
        "enabled": enabled(),
        "have_pymongo": _HAVE_PYMONGO,
        "db": MONGO_DB if enabled() else None,
        "interval_s": SYNC_INTERVAL,
        "last_run": _last["ran"],
        "last_ok": _last["ok"],
        "last_error": _last["error"],
        "last_pushed": _last["pushed"],
        "connected": False,
    }
    if not enabled():
        return out
    try:
        get_client().admin.command("ping")
        out["connected"] = True
    except PyMongoError as exc:
        out["connected"] = False
        out["last_error"] = out["last_error"] or str(exc)
    return out


def _loop() -> None:
    # Small initial delay so first sync runs after startup seeding settles.
    time.sleep(3)
    while True:
        try:
            sync_once()
        except Exception as exc:  # defensive: the mirror must never crash the app
            _last.update(ran=_now(), ok=False, error=repr(exc))
        time.sleep(max(SYNC_INTERVAL, 5))


def start() -> None:
    """Kick off the background mirror thread once. No-op when disabled."""
    global _thread
    reload_config()  # .env is loaded by now — pick up MONGO_URI set after import
    if not enabled():
        print("[mongo] cloud mirror DISABLED (set MONGO_URI to enable)", file=sys.stderr)
        return
    _ensure_state_table()
    if _thread and _thread.is_alive():
        return
    _thread = threading.Thread(target=_loop, name="mongo-sync", daemon=True)
    _thread.start()
    print(f"[mongo] cloud mirror ON → db '{MONGO_DB}', every {SYNC_INTERVAL}s",
          file=sys.stderr)
