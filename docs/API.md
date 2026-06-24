# API Reference — Ujjain VMS

Two services. All bodies are JSON.

- **Central Command** — `http://127.0.0.1:8000`
- **Checkpoint Node** — `http://127.0.0.1:8001` (one per zone)

Interactive docs at `http://127.0.0.1:8000/docs` (FastAPI/Swagger).

---

## Authentication

Bearer tokens, HMAC-signed by central (see `backend/shared/auth.py`). Three
principals:

| Principal | Obtains a token via | Used for |
|---|---|---|
| **Staff** (`commander` / `dispatcher` / `operator`) | `POST /api/auth/login` | admin/command endpoints; emergency-pass issuance |
| **Citizen** | `POST /api/auth/otp/request` → `/verify` (phone OTP) | booking, pass retrieval |
| **Node** | per-node token seeded in `checkpoints.token` (`NODE_TOKEN` env) | `/api/sync/*` |

Send as `Authorization: Bearer <token>`. Demo staff accounts (password
`simhastha28`): `commander.a`, `commander.b`, `dispatcher`, `op.<zone>`.

> **Still open (Phase-1, see [AUDIT.md](./AUDIT.md)):** CORS is `*`; the node-local
> control routes (`/network`, `/denyall`) are intentionally **unauthenticated** — they
> are the physical "human with a barrier" kill-switch floor that must work with zero
> system input.

### `POST /api/auth/login`
Staff login. `{"username":"commander.a","password":"simhastha28"}` →
`{"token":"...","role":"commander","name":"Cmdr. A. Sharma (Command)","zone":null}`.
`401` on bad credentials.

### `POST /api/auth/otp/request`
Citizen phone verification (anti-tout identity binding). `{"phone":"9876543210"}` →
`{"sent":true,"phone":"9876543210","demo_otp":"951495","note":"..."}`.
The OTP is returned as `demo_otp` in the prototype; a real SMS gateway sends it.
`400` if not a 10-digit number.

### `POST /api/auth/otp/verify`
`{"phone":"9876543210","code":"951495"}` → `{"token":"...","phone":"9876543210"}`.
`401` incorrect/expired · `429` after 5 attempts.

---

## Central Command (`:8000`)

### Citizen booking

#### `GET /api/zones?date=YYYY-MM-DD`
Zones with aggregate capacity for the date (powers the fill-bars). *(Public.)*

```json
[{"id":"indore","name":"Zone 1 — Indore Road","road":"Indore Road",
  "lng":75.40,"lat":23.13,"capacity":720,"booked":0,"available":720,"locked":false}]
```

#### `GET /api/zones/{zone_id}/slots?date=YYYY-MM-DD&slot_type=public|vip`
Arrival windows ("showtimes"). `404` if none match. *(Public.)*

#### `GET /api/zones/{zone_id}/lots`
Real parking lots for a zone with live fill — the booking wizard's lot view (replaces
the old cosmetic bay grid, C1). `primary` marks the lot a new booking is tagged to. *(Public.)*
```json
[{"id":"indore-1","name":"P1 — Sugar Mill","capacity":4,"occupied":0,"available":4,"primary":true}]
```

#### `POST /api/bookings`  *(auth required)*
Create a booking; returns the signed ticket, QR (PNG data URL), 6-char code, the
assigned **parking lot** (+ coordinates for the Navigate link), and a simulated SMS.

- **Public vehicles** require a **citizen** token; the booking is bound to that phone
  and counts against the per-phone cap (`BOOKING_CAP_PER_PHONE`, default 3 per date).
- **Emergency** vehicles (`vtype:"emergency"`) require a **dispatcher/commander** token
  — the public cannot self-issue them.

Request:
```json
{"slot_id":"indore-2028-04-27-06:00","vtype":"car","vcount":1,
 "slot_type":"public","plate":"MP09 AB 1234","vdesc":"White Swift"}
```
- `vtype` ∈ `2w | car | bus | emergency` · `vcount` 1–50 · `slot_type` ∈ `public | vip`
- `plate` is **normalized and bound into the signed pass** (anti-transfer)
- `vdesc` optional free text (colour/model) shown to the operator

Response:
```json
{"id":"<uuid>","code":"2TFJ84","token":"<base64url>.<base64url>",
 "qr":"data:image/png;base64,...","zone":"indore","date":"2028-04-27",
 "window":"06:00–07:00","vtype":"car","vcount":1,"slot_type":"public",
 "plate":"MP09AB1234","vdesc":"White Swift",
 "lot_id":"indore-1","lot_name":"P1 — Sugar Mill","lot_lat":23.13,"lot_lng":75.40,
 "sms":"UJJAIN VMS: PUBLIC slot booked. Indore 2028-04-27 06:00–07:00. Park at P1 — Sugar Mill. Entry code 2TFJ84. ..."}
```
Errors: `401` no citizen token · `403` emergency without staff · `404` unknown slot ·
`400` slot_type mismatch · `409` slot full · `423` zone under lockdown ·
`429` per-phone booking cap reached.

#### `GET /api/bookings/{bid}`
Full booking row. `404` if unknown. *(Public.)*

#### `GET /api/my/bookings`  *(citizen token)*
Server-side pass retrieval keyed to the verified phone (so passes survive a new
device). Each row re-renders its QR from the stored token, with current `status` and
the assigned/booked `lot_name` + coordinates.

---

### Admin / Command Centre  *(staff token; mutations need `commander`)*

#### `GET /api/admin/overview?date=YYYY-MM-DD`  *(staff)*
Per-zone live operations (booked/arrived/noshow/revoked), checkpoint `last_sync`,
active lockdowns, server time.

#### `GET /api/admin/lots?zone_id=indore`  *(staff)*
Per-lot physical occupancy, reconciled from synced assignment events.
```json
{"zone_id":"indore","lots":[
  {"id":"indore-1","name":"P1 — Sugar Mill","capacity":4,"cascade_ord":0,
   "occupied":4,"available":0,"lat":23.13,"lng":75.40}]}
```

#### `POST /api/admin/lockdown`  *(commander)*
Activate a lockdown **and** flip in-scope `booked` bookings to `revoked`, tagged with
this lockdown id (so a lift restores only these). Single-commander — slamming the
brakes on is the safe direction.

Request: `{"scope":"ALL","reason":"stampede risk"}` (`scope` = `ALL` or a zone id)
Response: `{"ok":true,"scope":"ALL","active":true,"revoked":5}`

#### `POST /api/admin/lockdown/{scope}/lift`  *(commander + second commander)*
**Two-person rule.** Re-opening during a crisis is the dangerous direction, so the
acting commander's token **plus a second, distinct commander's credentials** are
required. Restores only the bookings this lockdown revoked (`revoked_by` tag).

Request (acting commander in the header): `{"second_username":"commander.b","second_password":"simhastha28"}`
Response: `{"ok":true,"scope":"ALL","active":false,"restored":5,"approvers":["Cmdr. A. Sharma (Command)","Cmdr. B. Verma (Command)"]}`
`403` if the second approver is missing, wrong-role, or the same person · `404` no active lockdown.

#### `POST /api/admin/capacity`  *(commander)*
Set every slot's capacity for a zone/date.
`{"zone_id":"agar","date":"2028-04-27","capacity":200,"slot_type":"public"}` →
`{"ok":true,"updated_slots":6,"capacity":200}` · `404` if no slots match.

> **Two capacities (C4):** a slot's `capacity` meters the *arrival rate* per window; on
> top, a zone's bookings can't exceed Σ(lot capacity) × `OVERBOOK_RATIO` (the physical
> ceiling). Booking past it → `409 "zone parking sold out for this date"`.

#### `POST /api/admin/reconcile`  *(commander)*
Mark still-`booked` vehicles whose arrival window has elapsed as `noshow`, reclaiming
their capacity (C6). `as_of` defaults to now; the command UI passes end-of-day.
`{"date":"2028-04-27","as_of":"2028-04-27T23:59:00+00:00"}` → `{"ok":true,"date":"...","noshow":4}`

#### `GET /api/admin/audit?limit=50`  *(staff)*
Most-recent audit rows (bookings, lockdowns with real actor identity, syncs,
capacity edits, two-person lifts).

---

### Sync (consumed by checkpoint nodes)

#### `GET /api/public_key`  *(public)*
`{"public_key_b64":"..."}` — the Ed25519 public key (the private key is never served).

#### `GET /api/sync/snapshot?zone_id=indore`  *(node token)*
The bookings + active lockdowns + **lot config** a node caches for offline use.
Bookings now include `plate`, `vdesc`, `lot_id`, `assigned_lot`.

#### `POST /api/sync/logs`  *(node token)*
Node uploads its scan log **and** parking-assignment events; central ingests both
(idempotent on event `id`), reconciles `admit`→`arrived` and `assigned_lot`, stamps
`last_sync`, and returns a fresh snapshot.

Request:
```json
{"checkpoint_id":"cp-indore","zone_id":"indore",
 "events":[{"id":"<uuid>","booking_id":"...","decision":"admit","reason":"admitted","offline":true,"ts":"..."}],
 "assignments":[{"id":"<uuid>","booking_id":"...","action":"overflow_redirect","from_lot":"indore-1","to_lot":"indore-2","reason":"P1 full","ts":"..."}]}
```
Response: `{"ingested":7,"assignments":2,"snapshot":{...}}`

#### `GET /`
Serves the built frontend (`frontend/dist/index.html`) when present.

---

## Checkpoint Node (`:8001`)

### Operator controls *(unauthenticated by design — physical kill-switch floor)*

#### `POST /network` — `{"on": true|false}`
Cut or restore the link to central. Returns `{"network":"on"|"off"}`.

#### `POST /denyall` — `{"on": true|false}`
The **manual kill switch** — deny every vehicle with no central input (emergency stays
exempt). Returns `{"denyall":"on"|"off"}`.

#### `GET /status`
```json
{"zone_id":"indore","checkpoint_id":"cp-indore","network":"on","denyall":"off",
 "last_sync":"...","cached_bookings":5,"pending_unsynced":0,
 "cached_lockdowns":[],"has_pubkey":true}
```

#### `GET /log?limit=25`
Recent local scan decisions (admit/deny, offline flag, synced flag).

#### `GET /lots`
Lots in cascade order with locally-owned occupancy (drives the operator Parking tab
and the manual-reassign picker).
```json
[{"id":"indore-1","name":"P1 — Sugar Mill","capacity":4,"cascade_ord":0,
  "occupied":2,"available":2,"full":false}]
```

---

### The 5-second decision (offline-capable)

#### `POST /verify`
Decide admit/deny. Provide **either** `token` (full QR payload) **or** `code` (the
6-char fallback), and optionally `observed_plate` (the plate the operator reads off
the vehicle).

Request: `{"token":"<base64url>.<base64url>","observed_plate":"MP09 AB 1234"}` or `{"code":"2TFJ84"}`

Response (admit):
```json
{"decision":"admit","reason":"admitted · park at P1 — Sugar Mill","booking_id":"...",
 "offline":true,"plate":"MP09AB1234","vdesc":"White Swift","plate_checked":true,
 "assigned_lot":"indore-1","lot_name":"P1 — Sugar Mill","overflow":false}
```

Decision logic (all local; no network needed for the `token` path):
- bad/empty token → `deny "invalid ticket: ..."` / `"no token or code"`
- `token.zone != node.zone` → `deny "wrong zone (...)"`
- signed `exp` passed → `deny "ticket expired"`
- `ENFORCE_WINDOW=1` and outside slot window → `deny "outside arrival window"`
- `observed_plate` provided and ≠ the plate bound in the pass → `deny "plate mismatch — vehicle not on pass"`
- lockdown cached **or** deny-all on, and not emergency → `deny "LOCKDOWN active — all vehicles denied"`
- cached booking `revoked` → `deny "booking revoked"` · already `arrived` → `deny "already used (duplicate)"`
- **lot assignment:** booked lot if it has room, else overflow down the zone cascade; whole zone full → `deny "zone parking full — no lot available"`
- valid signature but unseen since last sync → `admit "(soft-green: ...)"`

An admit marks the booking `arrived` locally (duplicate-catch even offline), consumes
a space in the assigned lot, and appends an assignment event.

#### `POST /reassign`
Operator manually moves an admitted vehicle to a different lot ("they already parked in
P5" / "P2 queue too long"). Adjusts occupancy, appends a `manual_reassign` event, works
fully offline; the signed pass is never edited.
`{"booking_id":"...","to_lot":"indore-3","reason":"driver already in P3"}` →
`{"ok":true,"lot_id":"indore-3","lot_name":"P3 — Bypass Ground","from_lot":"indore-2","over_capacity":false}`

#### `POST /exit`
Register a vehicle **leaving** so its lot frees a space — occupancy becomes a *current*
count, not cumulative arrivals (C5). `{"token":"..."}` or `{"code":"2TFJ84"}` →
`{"ok":true,"booking_id":"...","freed_lot":"indore-1"}`. Works offline; syncs up as an
`exit` scan event that marks the booking `departed` centrally. `409` if no active parked
vehicle for the pass.

#### `POST /sync`  *(sends the node token to central)*
The only endpoint that touches the network. Pushes the unsynced scan log **and
assignment events** with the node's delta cursor (`since`), then **upserts** the changed
bookings (delta, not full-replace — C12), refreshes lockdowns/lots, stores the new
`cursor` + a trusted-time floor + the plate-verify secret, and re-derives occupancy.

Response:
```json
{"ok":true,"pushed":7,"pushed_assignments":3,"ingested":7,
 "cached_bookings":2,"cached_lockdowns":0,"cached_lots":3,"last_sync":"..."}
```
(`cached_bookings` is the count in *this delta*, not the whole cache.)
`409` if the node's network is OFF · `502` if central is unreachable.

---

## Ticket token format (v2)

```
token = base64url(canonical_json(payload)) + "." + base64url(ed25519_signature)

payload = {
  "v": 2, "kid": "central-1",              # schema version + signing-key id (rotation)
  "bid": "<booking uuid>", "zone": "indore", "slot": "indore-2028-04-27-06:00",
  "date": "2028-04-27", "ws": "06:00", "we": "07:00",
  "vt": "car", "vc": 1, "st": "public",
  "ph": "b5a4546b6cf97c48", "pl": "1234", "vdesc": "White Swift",  # plate HMAC + last-4
  "iat": "<ISO>", "exp": "<ISO>",                  # hard expiry, enforced offline
  "jti": "<uuid>"                                  # unique id for replay analytics
}
```

The signature covers the canonical JSON bytes, so altering any field invalidates it.
The node verifies with the public key alone — no central round-trip. Two privacy/safety
notes (docs/AUDIT.md C8, C9): the plate is carried as a **keyed HMAC (`ph`) + last-4
(`pl`)**, never cleartext, so a random QR scan can't read the number plate — yet an
authenticated gate still verifies an observed plate offline (it holds the HMAC secret,
synced; it shows the full plate from its cache). And the **parking lot is deliberately NOT
in the signed payload** (mutable operational data, so the gate can reassign it without
breaking the signature — see [DESIGN-v2.md §9](./DESIGN-v2.md)).
