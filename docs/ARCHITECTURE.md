# Architecture — Ujjain VMS

This document explains *how* the prototype is built and *why* the pieces are
shaped the way they are. For the product rationale and pitch framing, see the
root [`CLAUDE.md`](../CLAUDE.md). For the review/hardening backlog, see
[`REVIEW.md`](./REVIEW.md).

---

## 1. The one design constraint

> **A checkpoint must admit / deny / log a vehicle with zero internet,
> indefinitely. Connectivity is an optimisation, not a dependency.**

Every structural decision below falls out of that single rule. During a peak
event (Simhastha, a VIP movement) the same crowd density that creates the
traffic problem also saturates cell towers — so the network is least reliable
exactly when the system matters most. The gate therefore owns enough state and
trust to decide on its own, and the cloud is something it *reconciles with* when
a link happens to appear.

---

## 2. Process topology

Three independent processes. They are separate on purpose — the checkpoint is a
different physical box (a Raspberry-Pi-class node at a road entry) from the
central cloud, so the prototype models them as separate services with separate
databases and a real, cuttable network link between them.

```
            ┌─────────────────────────────────────────────┐
            │  FRONTEND  (React + Vite)            :5173    │
            │  3 tabs: Book · Checkpoint · Command Centre   │
            └───────┬───────────────────────────┬──────────┘
        /api (central)                     direct (node, CORS)
                    │                           │
       ┌────────────▼─────────────┐   ┌─────────▼───────────────┐
       │  CENTRAL COMMAND  :8000   │   │  CHECKPOINT NODE  :8001  │
       │  FastAPI + SQLite         │   │  FastAPI + own SQLite    │
       │  - booking (BookMyShow)   │   │  - offline QR verify     │
       │  - admin / lockdown       │   │  - local booking cache   │
       │  - batch sync endpoints   │◄──┤  - append-only scan log  │
       │  - signs tickets (PRIV)   │   │  - holds PUBLIC key only │
       │  central.db               │   │  checkpoint_<zone>.db    │
       └───────────────────────────┘   └──────────────────────────┘
                 source of truth          works standalone
```

One checkpoint process runs **per zone** (`ZONE_ID=indore`, `dewas`, …), each
with its own SQLite file. `scripts/run.sh` starts central + N checkpoints +
the frontend.

---

## 3. Components

### 3.1 Central Command — `backend/central/`
- `app.py` — FastAPI app. Citizen booking, admin/command-centre, and the batch
  sync endpoints the nodes call. Serves the built frontend from `frontend/dist`
  when present.
- `db.py` — SQLite schema + seed data (7 Ujjain approach-road zones, event
  dates, hourly slots, a small VIP block per slot, **3 parking lots per zone in
  overflow-cascade order**, one checkpoint per zone with a sync token, and demo
  staff accounts). Idempotent column/seed migrations upgrade older DBs in place.
- Source of truth for capacity, bookings, lockdowns, and the reconciliation
  audit log. In production this becomes Postgres on the Smart City cloud; the
  code uses raw `sqlite3` to stay dependency-free.

### 3.2 Checkpoint Node — `backend/checkpoint/node.py`
- Separate FastAPI process with its **own** SQLite (`checkpoint_<zone>.db`).
- Holds the central **public key** only → verifies any ticket signature offline.
- Caches the bookings + lockdowns it pulled at the last sync.
- Appends every admit/deny to a local scan log that is never lost if the link
  never returns.
- Exposes the operator controls: network on/off, manual deny-all kill switch,
  and the batch `sync`.

### 3.3 Shared ticket crypto — `backend/shared/tickets.py`
- Ed25519 keypair generation (idempotent, `keys/`).
- `sign_ticket(payload)` / `verify_ticket(token, pubkey)`.
- `human_code(booking_id)` — deterministic 6-char operator-typeable fallback.
- `normalize_plate(...)` — canonical plate form for binding + gate comparison.

### 3.4 Shared auth — `backend/shared/auth.py`
- HMAC-signed bearer tokens (`make_token` / `verify_token`) over a server secret in
  `keys/session_secret`; PBKDF2 password hashing. Powers staff login, citizen
  phone-OTP, and per-node sync tokens. No session table — tokens are stateless.

### 3.5 Frontend — `frontend/`
- React + Vite, Tailwind **compiled into the bundle** (no CDN → styling works
  offline, which the pitch depends on).
- `src/api.js` — the single place that knows the endpoint URLs. Central is
  called via the relative `/api` (proxied in dev, same-origin when served by
  central); the node is called directly at its `http://127.0.0.1:8001` base
  (overridable + persisted in `localStorage`).
- `src/apps/` — `CitizenApp` (book + My Passes, phone-OTP gated), `OperatorApp`
  (gate scan, Parking/occupancy tab, reassign), `CommandApp` (commander-login gated
  dashboard, two-person lift). Shared UI in `src/ui/components.jsx`.

---

## 4. The trust model (offline verification)

This is the heart of the system. It is the same trust model as an airline
boarding-pass barcode: the proof is *inside the ticket*, so the scanner never
has to phone home.

1. **Issue (online, central):** central holds an Ed25519 **private** key. On
   booking it builds a compact payload and signs it:

   ```
   payload = {v, kid, bid, zone, slot, date, ws, we, vt, vc, st,
              ph, pl, vdesc, iat, exp, jti}
   token   = base64url(canonical_json(payload)) + "." + base64url(signature)
   ```

   The QR encodes `token`. A 6-char `code` is derived from the booking id as an
   SMS/manual fallback. Security-relevant fields: **`ph`/`pl`** bind the pass to one
   vehicle — a *keyed HMAC* of the plate plus its last-4, never cleartext, so a random
   QR scan can't read the number plate (privacy/DPDP, C8) yet an authenticated gate
   still verifies it offline; **`exp`** is a hard expiry the node enforces **offline**
   against a clock with a monotonic floor that defeats rollback (C9); `kid` lets the
   signing key rotate without re-provisioning every node. See [DESIGN-v2.md §3–4](./DESIGN-v2.md).

2. **Provision (once):** each checkpoint is given the central **public** key.
   In the field it is baked in at setup or fetched once over the first available
   link; in this prototype the node seeds it from the shared `keys/` dir and/or
   fetches it on first sync.

3. **Verify (offline, node):** the node splits the token, checks the signature
   with the public key, and confirms `payload.zone == this zone`. No network is
   touched. Tampering with any field breaks the signature.

4. **Duplicate / revoked checks** use the node's **locally cached** booking
   snapshot. A valid ticket that the cache hasn't seen since the last sync is
   admitted **soft-green** (tentatively) and flagged for reconciliation — the
   node can't prove it's unused while offline, so it errs toward admitting and
   lets central catch duplicates at sync.

---

## 5. Batch sync (push log / pull snapshot)

The node→central link is deliberately **batch-shaped**, not a per-vehicle live
call — the same model FASTag toll plazas use (settle after a cut-off cycle).
A single successful sync per day is enough to keep a gate useful.

```
POST :8001/sync   (only path that touches the network)
  1. collect unsynced scan_log rows
  2. POST them to central  /api/sync/logs   (push)
  3. central ingests (idempotent on event id), reconciles admit→arrived,
     stamps the checkpoint's last_sync, and returns a fresh snapshot
  4. node marks those rows synced
  5. node REPLACES its cached_bookings + cached_lockdowns from the snapshot (pull)
```

If the network is off, `/sync` returns `409` and the gate simply keeps running
on its existing local state. Reconnect later and the whole offline log flushes
up in one batch.

---

## 6. Lockdown — revoke that survives offline

The Mauni Amavasya / Maha Kumbh 2025 lesson: a system that needs the internet to
*stop* admitting vehicles is dangerous. So lockdown has **two** propagation
paths and a physical fallback:

1. **Data revoke (central):** `POST /api/admin/lockdown` (a **commander** action)
   records the lockdown *and* flips in-scope `booked` bookings to `revoked`,
   **tagged with the lockdown id** (`bookings.revoked_by`). Activating is fast and
   single-commander — slamming the brakes on is the safe direction.
2. **Sync propagation:** the lockdown rides the next snapshot into each node's
   `cached_lockdowns`; the gate then denies every vehicle even with the network
   off.
3. **Manual deny-all (node):** the operator can flip the node to deny-all with
   **no central input at all** — the instant, offline kill switch. A human with
   a barrier is the real authority; the software just makes it easy and logged.
   These node-local routes are intentionally **unauthenticated** — the physical floor.

**Lifting is two-person.** Re-opening during a crisis is the dangerous direction
(the Mauni Amavasya lesson), so `POST /api/admin/lockdown/{scope}/lift` requires the
acting commander **plus a second, distinct commander** to authenticate inline. The
lift restores **only** the bookings that lockdown revoked (via `revoked_by`).

**Emergency vehicles (`vt=emergency`) stay exempt** under any lockdown, matching the
real-world "only ambulance/police/essential" carve-out — and they can only be
**issued** by a dispatcher/commander, not self-served by the public.

---

## 6a. Identity, anti-tout & parking allocation

Two capabilities added on top of the core (full rationale in [DESIGN-v2.md](./DESIGN-v2.md)
and [AUDIT.md](./AUDIT.md)):

- **Identity-bound booking.** Public booking requires a phone-verified **citizen**
  token (OTP), capped per phone per date — the anti-tout control (the TTD/Tirupati
  precedent: 545 users booked 14,449 tickets). Passes are retrievable server-side by
  phone, so they survive a lost/cleared device instead of living only in `localStorage`.
- **Lot allocation + gate reassignment.** A booking is tagged with an *intended* lot
  (the zone's primary), but the **physical lot is decided at the gate**: the node admits
  into the booked lot if it has room, else overflows down the zone's named cascade
  (the Kumbh model). The operator can also **manually reassign** a vehicle ("they already
  parked in P5"). Crucially the lot is **not in the signed pass** — it's a mutable,
  append-only `assignment_event` layered on the immutable credential, so reassignment
  never needs the private key at the edge. Occupancy is owned locally per node (safe
  offline because one node owns each lot); the bounded-counter/escrow split is the
  documented Phase-2 generalization for multi-gate lots.

---

## 7. Data model (central)

| Table | Purpose |
|-------|---------|
| `zones` | 7 approach-road zones (id, name, road, lat/lng) |
| `slots` | per-zone, per-date arrival windows; `capacity`; `slot_type` public/vip |
| `lots` | physical parking lots per zone, `capacity`, `cascade_ord` (overflow order), lat/lng |
| `bookings` | the pass: vehicle, `plate`, `vdesc`, `lot_id` (intended) + `assigned_lot` (actual), `phone` (booker), status, `code`, signed `token`, `revoked_by` |
| `assignment_events` | append-only lot assignments/redirects/manual-reassigns uploaded from nodes |
| `checkpoints` | one per zone; per-node sync `token`; `last_sync` |
| `lockdowns` | scope (`ALL` or zone id), active, reason, actor |
| `users` | staff identities (commander/dispatcher/operator), PBKDF2 password |
| `otp_codes` | mock citizen phone-OTP store |
| `audit_log` | who did what, when (real actor identity) |
| `scan_events` | admit/deny decisions uploaded from nodes at sync |

Checkpoint node DB mirrors a thin slice: `cached_bookings` (incl. `plate`/`vdesc`/
`lot_id`/`assigned_lot`), `cached_lockdowns`, `cached_lots`, `lot_occupancy`
(node-owned counts), `scan_log` + `assignment_events` (with a `synced` flag), and a
`node_state` key/value store (`network`, `denyall`, `last_sync`, `pubkey_b64`).

---

## 8. Concurrency & integrity notes

- **Booking is atomic.** `create_booking` runs the capacity check + insert inside
  a `BEGIN IMMEDIATE` transaction so concurrent bookings for the same slot can't
  overbook (SQLite's reserved write lock serialises writers).
- **Sync ingest is idempotent** on `scan_events.id` (re-pushing the same log is
  safe).
- **The signed token is over canonical JSON** (`sort_keys`, tight separators),
  so verification is stable regardless of field order.

---

## 9. Hardware seams (left for Phase 1)

Everything physical is isolated behind the node's `/verify` and `/sync` so it can
drop in without touching the booking layer:

- **QR scanner** — any USB/phone camera feeding the `token` into `/verify`.
- **Real UPI PSP** — behind the mock pay step in the citizen app.
- **4G dongle / police wireless** — the opportunistic link `/sync` rides.
- **LoRa / Wi-Fi mesh** between adjacent checkpoints — optional, for zone-to-zone
  coordination without the cloud.
- **Geographic map** — the zone grid swaps for a Leaflet/OSM map behind the same
  capacity API (`lat`/`lng` already seeded).

See [`REVIEW.md`](./REVIEW.md) for the original hardening list, [`DESIGN-v2.md`](./DESIGN-v2.md)
for the plate-binding + lot-reassignment design (with two research passes), and
[`AUDIT.md`](./AUDIT.md) for the whole-system conflicts analysis and what's been
resolved (auth, two-person lift, identity binding) vs. still open (capacity unification,
delta sync, trusted clock).
