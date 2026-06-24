# VMS v2 — Design Notes: vehicle binding, parking allocation & QR hardening

**Status:** design + in-progress implementation
**Author:** Abhinav Pavithran (with Claude Code)
**Supersedes nothing** — this extends the v1 brief in `CLAUDE.md`. It records the
decisions behind the second build pass and the reasoning a pitch reviewer will ask about.

---

## 0. Why this document exists

Three real-world problems surfaced after the Phase-0 prototype worked end-to-end:

1. **People park wherever they find space**, not the spot on their pass. The pass
   authorises a *zone + time*, but there is no parking-allocation primitive at all,
   so self-allocation is the only possible behaviour. We need the gate operator to be
   able to **(re)assign parking on the spot**, and the citizen app to **navigate** there.
2. **The QR is a bearer token.** `plate` is captured by the API but never signed,
   never cached at the node, and never shown to the operator — so anyone holding the
   QR image gets in, on any vehicle. There is no link between the physical vehicle and
   the pass.
3. **"No one can duplicate the QR"** was an explicit ask. A signed QR *cannot* be made
   un-clonable; the honest goal is to make a clone **useless**.

This doc states the principles and the concrete changes for each.

---

## 1. The governing principle: immutable credential, mutable overlay

The system was conflating two different concerns:

| Concern | Question | Mutability | Lives in |
|---|---|---|---|
| **Entry authorization** | "May this vehicle enter Zone 3, 08:00–09:00?" | **Immutable** — it's what they paid for | the signed QR |
| **Parking allocation** | "Where inside the zone does it go?" | **Mutable** — fills unevenly, reassigned at the gate | append-only events |

> **Rule: the cryptographic credential is immutable and is NEVER edited in the field.
> Everything operational — lot assignment, "parked on the spot", plate correction,
> arrival — is an append-only event layered on top of the immutable pass.**

Why this matters: letting the operator "edit the pass" literally would require the
**central private signing key on every Raspberry Pi**. One stolen Pi would then forge
any pass, including VIP. So the operator never re-signs anything. The operator records
an *event* (`reassign_lot`, `plate_mismatch`, `arrived`) keyed by booking id; the pass
stays frozen and signed; the assignment is just data that overrides the default. This
is the existing `scan_log` generalised into an operational event log — additive,
offline-friendly, idempotent on sync (already keyed by event id).

---

## 2. Parking allocation → lot-level, not bay-level

**Decision: allocate at LOT granularity, not numbered-bay granularity.** Routing
vehicle #4,471,902 to bay "C-17" at 2.5-crore scale is fantasy — it just creates a
different chaos (everyone circling for their exact bay). The cosmetic bay-picker in the
current citizen UI (`ParkingMap`) is not wired to the backend and is illustrative only.

Model:

```
Zone (Indore Rd) → Lot P1, Lot P2, Lot P3 …  → marshals direct within the lot
```

- New `lots` table: `id, zone_id, name, lat, lng, capacity, vtype_allowed`.
- Booking assigns a **lot** (the natural overflow unit; §5 of the brief).
- The signed pass carries `lot` so the gate and navigation both know the destination.

**Operator "park on the spot" = a lot-reassignment event, not a pass edit:**

```
POST /reassign  { booking_id, new_lot, reason }   # offline-capable, logged, synced
```

When P2 is full the operator taps "send to P5"; it's logged, lot inventory updates, and
— connectivity permitting — the driver's app re-navigates. No key, no re-signing.

> Long-term: lot geometry should come **from** the BISAG-N / Gati Shakti GIS platform we
> plug into, referenced by external id, not hand-typed.

---

## 3. Vehicle ↔ pass binding (closes the verification hole)

Add the **plate** (and an optional free-text vehicle description — colour/model) into the
**signed** payload, into the node cache, and onto the operator screen.

- Operator sees: **"Expected: MP09-AB-1234 · White Car · VIP"** and eyeballs the actual
  plate. Match → admit. The match is part of the logged admit action.
- The operator may also type the **observed plate**; if it disagrees with the signed
  plate the node returns **DENY — plate mismatch**, fully offline (the plate is inside
  the signed token, so no lookup needed).

This is the boarding-pass model: the credential names the holder; a human (or, later,
ANPR) verifies the credential matches the physical thing.

**Privacy:** a plate in an offline-readable QR is PII — but the plate is already bolted
to the outside of the vehicle in plain view, so embedding it is defensible. Stricter
option (future): embed a salted hash, show the real plate from cache, fall back to
"ends in …34" when uncached. We start with the plain normalised plate.

**Long-term payoff:** once the plate is bound into the pass, the 10,000-camera ANPR the
command centre is already building can do the match automatically — the QR becomes
optional and the plate becomes the primary key. **Binding the plate now is the bridge
from manual gates to automated lanes later.**

---

## 4. What the QR carries (v2 payload)

| Field | v1 | v2 | Why |
|---|----|----|-----|
| `v` | ✗ | ✅ | payload schema version (forward-compat) |
| `kid` | ✗ | ✅ | key id → key **rotation** without re-provisioning every node at once |
| `bid` | ✓ | ✓ | booking id |
| `zone` | ✓ | ✓ | gate-checked |
| ~~`lot`~~ | ✗ | ❌ | **deliberately NOT in the signed pass** — see §9. The credential gates a *zone*; the parking lot is mutable operational data delivered out-of-band (app/SMS/gate), so it can be reassigned without ever touching the signature. (Revised after the §9 research; supersedes the earlier "add `lot`" line.) |
| `slot`,`date`,`ws`,`we` | ✓ | ✓ | arrival window |
| `vt`,`st` | ✓ | ✓ | vehicle / slot type |
| `vc` | ✗ | ✅ | vehicle count — gate should know it's a 40-seat bus |
| `plate` | ✗ | ✅ | the anti-transfer binding (§3) |
| `vdesc` | ✗ | ✅ | colour/model — speeds human verification |
| `iat` | ✓ | ✓ | issued-at |
| `exp` | ✗ | ✅ | **hard signed expiry** — node rejects a stale pass even with an empty cache |
| `jti` | ✗ | ✅ | unique token id → central replay / duplicate analytics |

Deliberately **out** of the QR (resolved from the node cache, because mutable): `status`
(booked/arrived/revoked), no-show flags, lot reassignments.

`exp` and `kid` are the quietly important ones: `exp` is a security check that survives a
totally empty cache; `kid` is what makes field key-rotation survivable.

---

## 5. Anti-duplication — the honest version

> **A signed QR cannot be made un-clonable. Ed25519 prevents *forgery*, not
> *photocopying*.** 50 people can screenshot one valid QR. The signature proves it's
> authentic; it says nothing about uniqueness of presentation.

The goal is to make a clone **useless**, via defence-in-depth:

1. **Plate binding (§3) — strongest lever.** 50 copies, but only the vehicle whose plate
   matches gets in. Low-tech, offline, decisive.
2. **Single-use local state.** First scan flips `status → arrived`; next scan → "already
   used (duplicate)". **Requirement:** one node per checkpoint, all lanes sharing that
   node's DB, so the "arrived" flag is visible across lanes instantly, even offline.
3. **Hard `exp` + window enforcement on in real ops.** A leaked QR has a short life.
   (`ENFORCE_WINDOW=0` is fine only for the 2028-dated demo.)
4. **Central replay analytics via `jti`.** Same booking/plate admitted twice → flagged
   for blacklisting. Detective control behind the preventive ones.
5. **(VIP only) rotating/online codes.** A 30-second-refresh QR makes a screenshot go
   stale — but breaks pure-offline, so reserve it for VIP.
6. **(VIP sticker) physical anti-counterfeit** — serialised hologram windshield sticker.

Pitch one-liner: *"Clone the QR all you want — it's bound to one number plate and burns
on first use, exactly like a boarding pass is useless without the matching passport."*

---

## 6. GPS navigation

- **Pre-arrival:** after booking, the app shows the assigned **lot** on a map with a
  "Navigate" button → `geo:`/Maps deep-link / handoff into the state's **Sahayak** app,
  using the lot's lat/lng. Zones already store lat/lng; lots add their own.
- **After a gate reassignment:** push the new destination to the app/SMS; fall back to a
  printed lot number / operator pointing at signage when the link is too weak.

> Honest framing for the pitch: at 2.5-crore scale wayfinding is **mostly physical** —
> colour-coded zones, directional signage, marshals. The GPS handoff is a convenience for
> the connected minority, not the load-bearing system. Consistent with "connectivity is
> an optimisation, not a dependency."

---

## 7. Long-term architecture punch list (ranked by risk)

1. **🔴 The kill switch is unauthenticated.** `/api/admin/lockdown`, `/denyall` have no
   auth — anyone reachable can trigger *or clear* a lockdown and revoke every booking.
   For a system whose value is a *safe* emergency stop, this is the scariest gap. RBAC +
   signed admin actions + real identities in the audit log. **Fix before any pilot.**
2. **🔴 Sync ingest is unauthenticated.** `/api/sync/logs` accepts forged scan events.
   Give each node its own keypair (separate from the central signing key) and sign
   uploads → also non-repudiation of which node admitted what.
3. **🟠 Snapshot sync won't scale.** `/sync` does `DELETE all + reinsert` the whole zone's
   bookings every time — O(all) per sync over 2G. Move to **delta sync** (cursor) +
   compact **revocation list / Bloom filter** for offline "is this revoked?".
4. **🟠 Key rotation is all-or-nothing.** Add `kid` (done in v2 payload) and let nodes
   hold multiple public keys.
5. **🟠 Offline clock = security dependency.** `exp`/window trust the node clock; an
   offline Pi drifts and a clock rollback revives expired passes. Cheap fix: GPS-disciplined
   or RTC clock (likely already have GPS hardware for lot coordinates).
6. **🟡 Booking-burst write bottleneck.** `BEGIN IMMEDIATE` serialises per-slot bookings
   on a single SQLite writer. At lakhs/min when a Shahi Snan slot opens, move to Postgres
   row-locks or a hold→confirm reservation pattern (what BookMyShow actually does).
7. **🟡 Privacy / DPDP Act.** Plate + movement = a citizen vehicle-movement trail. Need
   retention limits, access control, lawful basis. Have an answer ready for the pitch.

---

## 8. Implementation order (smallest blast radius first)

1. **Plate-in-signed-payload + operator sees & confirms vehicle match.** ← *this pass*
2. Payload hardening fields (`v`, `kid`, `exp`, `jti`, `vc`, `vdesc`). ← *folded into #1*
3. Lots table + `lot` in pass + operator `/reassign` event.
4. Citizen-app map + "Navigate" deep-link to the assigned lot.
5. Auth on the kill switch + sync (must precede any real pilot; doesn't affect the demo).

---

## 9. Lot reassignment & offline occupancy — practical plan (research-backed)

This section is the output of a deep-research pass (Kumbh 2025 traffic plans, Hajj/Nusuk,
IATA BCBP, distributed-systems literature on bounded counters/CRDTs). It supersedes the
hand-wavy "operator reassigns a lot" sketch in §2 with a concrete, scale-honest design.

### 9.1 What the research settled

1. **Granularity = lot, with named overflow cascades. Never numbered bays.** Kumbh 2025
   published exactly this: *"vehicles parked at the sugar mill lot; if full → Pure Surdas,
   Badra Sonauti, Samaymai lots"* per approach route. We mirror it: each zone has an
   **ordered cascade** of lots. [etvbharat, Kumbh 2025 traffic plan]
2. **Credential ≠ assignment (IATA boarding-pass pattern).** The signature is a *separate*
   field; any edit to the data breaks it; verifiers hold only the public key and check
   offline. → **The lot is NOT in the signed pass.** The pass authorizes a *zone*; the lot
   is mutable operational data layered on top. [IATA BCBP v7]
3. **A plain counter / PN-Counter is UNSAFE for occupancy.** A capacity ceiling is a global
   invariant; two offline gates each seeing "1 free" both admit → converge to over-capacity.
   The adversarial verifier explicitly *refuted* "PN-Counter is the right primitive." [arXiv
   1503.09052, designgurus]
4. **The safe primitive is a bounded/escrow counter.** Pre-split each lot's capacity into
   **per-node quotas**; a gate admits against its *own slice* with zero coordination, and
   redirects (or refuses) when its slice is exhausted. Safety holds even fully partitioned;
   worst case a node *conservatively refuses* while capacity technically remains — a fail-safe,
   which for crowd safety is desirable. [Balegas et al. SRDS 2015, Sypytkowski]
5. **Overflow doctrine: never say "full," always redirect; load-aware beats greedy-nearest.**
   Greedy-nearest was *refuted* as a peak strategy (early arrivals block later ones). But at
   region-wide saturation no algorithm replaces marshals + signage + the kill switch. [Wang
   thesis, ParkingToday, Kumbh Mauni-Amavasya revoke-all]
6. **Deny-all/lockdown must short-circuit BEFORE any quota/assignment logic**, with zero
   system input, and VIP is revoked first. [Kumbh 2025]

### 9.2 The key simplification for *our* topology

The escrow machinery exists to make occupancy safe when **multiple gates feed one lot while
offline**. In the Phase-0 prototype each zone has **exactly one checkpoint node**, and lots
belong to a zone — so every admit into a lot flows through a *single owner*. That means a
**plain local occupancy counter is already safe** in the prototype (single-writer, no
distributed invariant to violate).

> So: build the **single-owner local counter now**; treat it as the degenerate
> one-slice case of the escrow model. The bounded-counter quota split is the documented
> Phase-2 generalization for multi-lane / shared lots — *the same code path, with granted
> quota < capacity*. This is exactly the research's "do NOT build real CRDT machinery for
> the prototype" guidance.

Two distinct capacities per lot, with different consistency needs:
- **Bookable capacity** — decremented centrally at booking time (single SQLite writer,
  already consistent via `BEGIN IMMEDIATE`). No distributed problem.
- **Physical occupancy** — decremented at the gate on admit. Single-owner in the prototype;
  escrow-quota'd in Phase 2.

### 9.3 Data model (additions)

```sql
CREATE TABLE lots (
  id          TEXT PRIMARY KEY,          -- e.g. 'indore-P2'
  zone_id     TEXT NOT NULL REFERENCES zones(id),
  name        TEXT NOT NULL,             -- 'Sugar Mill Lot'
  route_tag   TEXT,                      -- approach road this lot serves
  capacity    INTEGER NOT NULL,          -- physical spaces
  cascade_ord INTEGER NOT NULL,          -- overflow order within the zone (0 = primary)
  lat REAL, lng REAL                     -- for the citizen Navigate deep-link (§6)
);

-- Physical occupancy, owned by the node in the prototype. In Phase 2 this row is
-- per (lot_id, node_id) with `granted` < capacity = the escrow slice.
CREATE TABLE lot_occupancy (
  lot_id   TEXT NOT NULL,
  node_id  TEXT NOT NULL,
  granted  INTEGER NOT NULL,             -- = capacity for the single owner (prototype)
  consumed INTEGER NOT NULL DEFAULT 0,   -- admits so far
  PRIMARY KEY (lot_id, node_id)
);

-- The mutable assignment layer: append-only, one row per gate decision.
-- Optional per-node hash chain (prev_hash + HMAC with a node secret) makes it
-- tamper-evident and offline-verifiable — cheap, good pitch point. [tracehold]
CREATE TABLE assignment_events (
  id         TEXT PRIMARY KEY,           -- uuid at the node
  booking_id TEXT,
  zone_id    TEXT,
  node_id    TEXT,
  action     TEXT,                       -- 'assign' | 'overflow_redirect' | 'manual_reassign'
  from_lot   TEXT,                       -- null on first assign
  to_lot     TEXT,
  reason     TEXT,
  ts         TEXT,
  prev_hash  TEXT,                       -- optional hash chain
  hmac       TEXT                        -- optional, per-node secret
);
```

`bookings` gains `lot_id` (the lot reserved at booking time — the citizen's *intended*
destination, mutable, NOT signed). Delivered to the app/SMS, never into the QR.

### 9.4 Gate reassignment flow (extends `_decide`)

```
1. verify pass signature offline (public key only)         ← existing
2. LOCKDOWN / deny-all short-circuit  ← MUST be before step 5, zero system input
3. revoked / duplicate checks (cache)                       ← existing
4. plate binding check                                       ← existing (slice #1)
5. ASSIGN LOT:
     target = booking.lot_id (booked lot)
     if occupancy(target).consumed < granted: consume 1, action='assign'
     else: walk zone cascade by cascade_ord to first lot with free quota,
           consume 1 there, action='overflow_redirect', from=target to=picked
     if no lot in the cascade has quota → DENY 'zone parking full' (or hold)
6. append assignment_event (+ optional hash-chain link)
7. return assigned lot to the operator → driver told via signage / printed slip / app push
   — the pass is NEVER reissued or edited
```

Plus a **manual override**: an operator action `manual_reassign(booking_id, actual_lot,
reason)` for the exact case you raised — the driver already parked somewhere, or a marshal
judges P2's queue too long. It records where the vehicle *actually* went and adjusts
occupancy. Same append-only event, `action='manual_reassign'`.

### 9.5 Offline occupancy sanity & sync

- **Offline:** the node admits against its local `lot_occupancy.consumed < granted`. In the
  prototype (single owner) this can never over-fill. Fully partitioned for hours = still safe.
- **At sync:** push `assignment_events` + per-lot `consumed`; pull lot config, cascade order,
  revocations, and (Phase 2) any quota re-grant. Central re-derives true occupancy =
  `Σ consumed` across nodes per lot. Events are append-only and idempotent on `id` (same as
  today's `scan_events`), so re-sync is safe.
- **Conflict that CAN happen even in the prototype:** a vehicle admitted offline into a lot
  that was concurrently locked down centrally. Resolution: lockdown/revocation wins on
  reconcile; the event is flagged for the command centre, not silently dropped (open
  question #3 in the research — needs a human escalation path, not a clever auto-merge).

### 9.6 Overflow auto-routing rule

- Primary = **static named cascade** per zone (`cascade_ord`), the Kumbh model — simplest,
  and what marshals can also follow on paper if the system is down.
- **Never reject** while any cascade lot has quota; only DENY when the whole zone's cascade
  is exhausted or lockdown is active.
- *Enhancement (not prototype):* pick the cascade lot with the **most free quota** (load-aware)
  rather than strict order — research shows this beats greedy-nearest at peak.

### 9.7 Deliberately NOT in the prototype

| Skipped | Why | When |
|---|---|---|
| Real CRDT merge libraries | Single-owner counter is safe at our topology | Phase 2 (multi-gate lots) |
| Live peer-to-peer quota borrowing | Central re-grant at sync is enough | Phase 2 |
| Bounded-counter quota slices (`granted` < capacity) | Degenerates to full ownership now | Phase 2 |
| GA / route-optimization solving | Static cascade is sufficient & legible | Phase 2+ |
| Numbered-bay granularity | Unmanageable at 2.5cr; lots only | never (by design) |
| Private key at the edge | Breaks the whole trust model | never |
| HMAC hash-chained log | *Recommended* but optional for the demo (~10 lines); plain append-only acceptable for Phase 0 | optional now |

### 9.8 Open questions to carry into the pitch (don't pretend these are solved)

1. **Escrow split policy** — equal slices vs demand-weighted by route history vs dynamic
   re-grant each sync? An offline node holding unused quota *strands* capacity.
2. **Who owns cascade config** — zone commander vs central command — when they disagree mid-event?
3. **Reconcile ordering** — deterministic rule when an offline admit collides with a
   concurrent lockdown, and the human escalation path for an impossible over-capacity sum.
4. **Connectivity SLA** — occasional 2G vs multi-hour blackout directly sizes how big each
   node's escrow quota must be to avoid premature refusal during a long partition.
</content>
</invoke>
