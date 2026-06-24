# VMS — Whole-System Audit: conflicts, gaps & target architecture

**Goal lens:** a **smart · secure · reliable · durable** vehicle management system for
Ujjain Simhastha. This audit reads the *entire* app (central API, checkpoint node, both
data models, all three frontends) and asks one question per finding: *does this feature
help, or does it quietly fight one of those four goals?*

It builds on `REVIEW.md` (which lists known *gaps*) and focuses on what that doc doesn't:
**features that conflict** — with each other, or with the goal. Scenario-research findings
(real-world failure modes at Kumbh/Hajj) fold into §6 when the research pass completes.

---

## 1. Scorecard — where the app stands today

| Goal | Strong | Weak / contradicted |
|---|---|---|
| **Smart** | Slot booking, lot overflow cascade, gate reassignment, capacity planner | Cosmetic bay-picker (false precision), no no-show reclaim, no exit/occupancy release, no demand response, fixed seed config |
| **Secure** | Ed25519-signed offline passes, plate binding, lockdown→revoke | **Unauth kill switch**, self-issuable emergency passes, open role-switch, **anonymous uncapped booking (touts)**, plate PII, clock-trust, no operator identity |
| **Reliable** | Offline-first gate, BEGIN IMMEDIATE anti-overbook, idempotent sync ingest | Bookable≫physical capacity mismatch, soft-green replay, single-writer burst limit, lockdown-restore over-reach |
| **Durable** | Append-only logs, migrations, SQLite + snapshot | localStorage-only passes, full-snapshot sync, no key rotation, no backup/retention policy |

---

## 2. Conflicting features (the headline)

These are not just "missing" — they are **present features that undermine a goal**. Ranked
by how directly they break the four goals.

> **Status:** C1–C10, C12, C13 are now **resolved** (see the §5 status table and notes).
> Still open: **C11** (soft-green offline replay — an accepted offline-first property, bounded
> by plate binding + `exp` + duplicate flagging) and CORS/real-UPI/admin-map polish.

### C1 — Cosmetic bay-picker vs. real lot allocation  ⟂ *smart, reliable*
The booking wizard has a BookMyShow-style **"Choose your parking bay"** step
(`ParkingMap`/`bayLabel`, `CitizenApp.jsx` step 2). It is **never sent to the backend** —
`createBooking` omits it; it lives only in `localStorage` as `bay: bayLabel(bay)`. So the
citizen is shown a numbered-bay grid and "reserves" B7 — a promise the system cannot keep
and, per the §9 research, *should not make* at 2.5cr scale. Meanwhile the pass now also
shows the **real assigned lot**. Two parking concepts, one fictional.
→ **Resolve:** replace the bay grid with a **lot picker / live lot-fill visualization**
(real `lots` + occupancy), or demote "bay" to an explicit within-lot hint. Stop selling a
specific spot.

### C2 — Open role-switch + unauth command vs. a *safe* kill switch  ⟂ *secure*
Anyone can open **Command Centre** (`App.jsx` `pickRole`) and hit **Lockdown ALL / Lift
lockdown**; the backend `/api/admin/lockdown` is unauthenticated too. The single most
safety-critical pair of actions — *revoke everything* and, worse, *re-open during an
emergency* — is the **least** protected in the system. The kill switch's whole value is
that only the right authority can flip it.
→ **Resolve:** authenticated commander identity; **two-person rule for *lift*** (re-opening
is the dangerous direction — Mauni Amavasya); real identity in the audit log; physical
deny-all stays as the floor.

### C3 — Self-service emergency vehicle type vs. lockdown integrity  ⟂ *secure*
`vtype='emergency'` is selectable through the public booking API
(`BookingReq` pattern `…|emergency`). Emergency vehicles are **lockdown-exempt** (`node.py`
`_decide`), **skip lot allocation**, and have **footprint 0** (book infinite). So any member
of the public can mint a pass that walks straight through the exact lockdown that is meant
to stop everyone. The safety exemption is self-subvertible.
→ **Resolve:** emergency class issuable **only by authorized actors**; visually/cryptographically
distinct; counted, not footprint-0-infinite.

### C4 — Two capacity systems that don't talk  ⟂ *reliable, smart*
**Bookable** capacity (slots, e.g. indore 120/slot × 6 slots = 720/day) and **physical**
capacity (lots, indore 4+4+80 = 88) are independent and wildly mismatched. The system
**sells far more passes than there are physical spaces**, guaranteeing gate-side "zone
parking full" denials for people *who paid and hold a valid pass*. There is no overbooking
policy, no refund path, no reconciliation between the two numbers.
→ **Resolve:** one governed capacity model — bookable ≤ Σ lot capacity + an explicit,
documented overbook ratio sized to the no-show rate, with a refund/redirect policy when a
valid pass can't be honored.

### C5 — Occupancy counts admits, never releases (no vehicle exit)  ⟂ *reliable, smart*
`lot_occupancy.consumed` only ever **increments** (on admit) — there is no exit event, so
"occupancy" is really *cumulative arrivals*. Over a multi-slot day every lot monotonically
fills and never frees; eventually everything overflows then denies, even as vehicles
physically leave. The model captures entry but not the parking lifecycle.
→ **Resolve:** model exit (gate-out scan, or time-based turnover estimate); occupancy =
current, not cumulative. At minimum, reset/age occupancy per slot or per day.

### C6 — No-show status defined but never set  ⟂ *smart, reliable*
`noshow` exists in the schema and the citizen badge logic, but **nothing ever sets it**
(confirmed in `REVIEW.md`). Held-but-unused capacity is never reclaimed, compounding C4.
→ **Resolve:** a sweep that marks past-window un-arrived bookings `noshow` and **returns
their capacity** to the pool (and feeds the overbook ratio in C4).

### C7 — Lockdown "restore" over-reach  ⟂ *reliable, durable (audit integrity)*
`clear_lockdown` runs `UPDATE bookings SET status='booked' WHERE status='revoked' AND
<scope>` — it un-revokes **every** revoked booking in scope, not only those this lockdown
revoked. The moment individual/fraud revocations exist, lifting a lockdown silently
resurrects them. The code comment concedes "demo-grade reversal: no partial states."
→ **Resolve:** tag revocations with their cause (lockdown id vs manual); restore only what
this lockdown revoked.

### C8 — Plate-in-QR: anti-fraud vs. privacy  ⟂ *secure (two senses)*
Binding the plate into the signed pass (good against transfer) makes it **readable by anyone
who scans the QR**, and builds a central vehicle-movement trail — a DPDP-Act exposure.
→ **Resolve:** conscious trade — embed a salted plate **hash** (show real plate from cache);
define retention limits and access control; state the lawful basis.

### C9 — Time-based security on an offline clock  ⟂ *secure, durable*
`exp` and the arrival-window check trust the node's wall clock (`node.py` `_expired`,
`_within_window`). An offline Pi drifts, or an attacker rolls the clock back to revive an
expired pass. The security control depends on the very thing (sync/time) the design assumes
is absent.
→ **Resolve:** GPS-disciplined or RTC clock at nodes; reject on implausible time; treat `exp`
as advisory until a trusted time source is confirmed.

### C10 — Passes live only in the browser  ⟂ *durable, smart (inclusion)*
"My Passes" is `localStorage` (`api.js`), keyed to one browser. Clear cache / new phone /
shared family device → passes vanish, with no account-based recovery and no way to look up
"my booking" without the opaque id. Real devotees share phones, lose phones, use feature
phones.
→ **Resolve:** phone-number identity (OTP) with server-side pass retrieval; the SMS code path
already exists — make it a first-class recovery channel.

### C11 — Soft-green offline replay  ⟂ *secure vs. reliable* (accepted, but bound it)
A validly-signed pass unseen since last sync is admitted "soft-green" with no dedup
(`node.py`), so copies can clear different checkpoints before sync. It's an inherent
offline-first tradeoff (`REVIEW.md` H1); plate binding + short `exp` shrink the window but
don't close it.
→ **Resolve:** keep, but **bound** — enforce `exp`/window in prod, one-node-per-checkpoint
shared state, loud duplicate-flagging + plate-reuse analytics at reconcile.

### C12 — Single-writer booking at peak  ⟂ *reliable, smart (at the moment it matters most)*
`BEGIN IMMEDIATE` serializes per-slot bookings on one SQLite writer. The burst the system
exists for — a Shahi Snan slot opening to lakhs/min — is its weakest point.
→ **Resolve:** Postgres row-locks or a hold→confirm reservation/queue; pre-materialized
inventory; the brief already permits Postgres centrally.

### C13 — Anonymous unlimited booking vs. fair allocation (touts)  ⟂ *smart, secure* — *surfaced by research*
Booking is account-less and uncapped (`api.js` localStorage; `create_booking` takes no
identity). Real religious-event booking systems are **provably gamed**: at Tirupati (TTD),
**14,449 darshan-ticket transactions came from just 545 users, one person booked 225**, plus
fraudulent IDs — which forced TTD to Aadhaar/eKYC/biometric verification
([Deccan Chronicle](https://www.deccanchronicle.com/southern-states/andhra-pradesh/ttd-cracks-down-on-suspicious-darshan-ticket-bookings-1814706)).
Our offline-verifiable QR stops *forgery at the gate* but does **nothing** against *hoarding at
the booking stage*. Without identity binding, slot inventory gets bulk-booked and resold;
the fairness the slotting model promises evaporates.
→ **Resolve:** identity-bound booking (phone-OTP minimum, Aadhaar/eKYC for scale) with
**per-identity booking caps**, rate-limiting, and bulk-pattern detection. This rides the same
identity layer as C10.

---

## 3. Gaps already tracked in REVIEW.md (not re-litigated here)

Auth/CORS, booking-enumeration + deterministic fallback code, private key at rest, sync
ingest bounds, true delta sync, geographic map, overflow-to-next-zone. This audit treats
those as **accepted-and-scheduled**; the items in §2 are the ones that are *actively
contradictory* and deserve a decision, not just a backlog slot.

---

## 4. Target architecture (practical, not gold-plated)

Five moves, each resolving a cluster above, sized for a fundable pilot — not a rewrite.

1. **Identity & authority layer (secure).** Three real principals: *citizen* (phone+OTP,
   server-stored passes), *operator* (device-bound node cert + shift PIN), *commander*
   (named login). Authorize by principal: emergency issuance → commander/dispatcher only;
   **lift-lockdown → two-person**. Node→central sync authenticated by a **per-node keypair**
   (also gives non-repudiation). This single layer closes C2, C3, C10 and the REVIEW auth gaps.
2. **One capacity truth (smart + reliable).** Bookable = Σ lot capacity × governed overbook
   ratio; no-show sweep reclaims (C6); occupancy releases on exit/turnover (C5); a valid pass
   that can't be honored gets an auto-redirect + refund path (C4). Capacity stops being two
   numbers that disagree.
3. **Kill switch as the hardest, most-reliable path (secure + reliable).** Authenticated,
   two-person lift, cause-tagged revocations (C7), physical deny-all as the floor, priority
   short-circuit before all parking logic (already true — keep it).
4. **Trust the edge, but verify time & identity (durable).** RTC/GPS clock (C9), signed node
   identity, delta sync + compact revocation set, bounded payloads. The edge stays
   authoritative offline; it just stops trusting its own clock and unauthenticated peers.
5. **Inclusion & honesty in the UX (smart).** Replace the fictional bay-picker with real
   lot visualization (C1); make SMS/IVR booking + retrieval first-class; handle walk-ins and
   PwD lanes at the gate; never show precision the system can't honor. (Scenario research, §6,
   sharpens this list.)

---

## 5. Suggested priority order

| # | Move | Resolves | Blocks pilot? | Status |
|---|------|----------|---------------|--------|
| 1 | Auth + commander identity + two-person lift | C2, C3 | **Yes** — safety-critical | ✅ **done** |
| 2 | Unify capacity (overbook ratio + no-show sweep + exit) | C4, C5, C6 | Yes — trust/refunds | ✅ **done** |
| 3 | Replace cosmetic bay-picker w/ real lot view | C1 | No — but cheap & high-clarity | ✅ **done** |
| 4 | Cause-tagged revocations | C7 | No | ✅ **done** (revoked_by) |
| 5 | Phone-OTP identity + per-id caps + server pass retrieval | C10, C13 | Yes for real users | ✅ **done** |
| 6 | Node identity (sync auth) | (sync) | Pilot | ✅ **done** |
| 7 | Citizen map + Navigate deep-link | UX/§6 | No | ✅ **done** |
| 8 | Delta sync + plate hash + trusted clock | C8, C9, C12 | Phase 2 hardening | ✅ **done** |

> **Implemented in the capacity + edge-hardening pass:** **physical-capacity ceiling**
> (bookable ≤ Σ lot capacity × `OVERBOOK_RATIO`, C4); **no-show reconcile** that reclaims
> capacity (C6); **gate-out exit** so lot occupancy is a *current* count, not cumulative
> arrivals (C5); **real lot view** replacing the cosmetic bay-picker (C1, dead code
> removed); **delta sync** (cursor on `updated_at`, upsert not full-replace, C12);
> **plate hash** — the QR carries a keyed HMAC + last-4 instead of a cleartext plate, with
> offline verification preserved (C8); **trusted clock** with a monotonic floor from the
> last sync that defeats clock-rollback (C9). Remaining open: CORS lockdown, real UPI, the
> admin geographic map, live escrow/quota for multi-gate lots (C11 stays an accepted
> offline-first property), zone-to-zone redirect at booking time.

> **Implemented this pass:** staff auth (commander/dispatcher/operator) with HMAC bearer
> tokens + PBKDF2 passwords; **two-person lockdown lift** (a second distinct commander
> authenticates inline); **cause-tagged revocations** so a lift restores only what that
> lockdown revoked (C7); **emergency passes restricted** to dispatcher/commander (C3);
> **node sync authenticated** by per-node token (forged-event gap closed); **phone-OTP
> citizen identity** with **per-phone booking caps** (C13) and **server-side pass retrieval**
> (C10); **citizen map + Navigate deep-link** to the assigned lot. Deliberately left open:
> node-local control routes (`/network`, `/denyall`) stay unauthenticated **by design** —
> they are the physical "human with a barrier" floor that must work with zero system input
> (research §6, Mauni Amavasya). CORS lock-down, capacity unification (C4/C5/C6), the
> bay-picker swap (C1), and edge hardening (C8/C9/C11/C12) remain.

---

## 6. Real-world scenarios (research-backed)

Deep-research pass (adversarially verified; Maha Kumbh 2025, Tirupati, Simhastha 2028 plans).
Each row maps a *verified* real-world failure mode to a design implication for the VMS.

| Scenario (verified) | Evidence | Freq × danger | Design implication | Maps to |
|---|---|---|---|---|
| **Mauni Amavasya crush → revoke ALL passes incl. VVIP, "no exceptions", no-vehicle zone** | DD News, ETV Bharat, Wikipedia (29 Jan 2025; 30+ official, 70–82 disputed) | Rare × catastrophic | Blanket no-vehicle declaration must be a **first-class operation**; VIP revoked as easily as public; physical deny-all is the floor | C2, C3, C7 |
| **Lockdown issued via 15-region video conf, executed physically on the ground** | PTC News, Business Standard | Rare × catastrophic | Revoke-all must **propagate through a chain + survive offline nodes**; never depend on one connected control room | C2 |
| **Closures created contraflow** (people reversed toward closed pontoon bridges; barrier broke; density >8/m²) | Wikipedia, Down To Earth, arXiv 2502.03120 | Rare × catastrophic | **A zone closure must not create a sudden bottleneck or trap people** — closures coordinate with exit/contraflow; checkpoints sit at the *border* so denial keeps vehicles out of the core (good), but must meter, not slam shut | **new** |
| **~300 km approach-road gridlock** (volume + missing diversions + poor signage + mismanaged parking) | Down To Earth, Tribune, Outlook | Frequent × high | **Arrival-window metering + pre-assigned parking + physical signage**; an app cannot substitute for diversions/signage on the ground | C4, C1 |
| **Official fix: holding/buffer areas at border points to meter inflow** | Outlook, India TV, WION | Frequent × high | The checkpoint node *is* a **metered border holding-point** — admit into a buffer, release per situation. Validates the whole slot/meter concept | C4 |
| **Peak connectivity load: 20M voice + 400M data requests in one day** | Ericsson (primary), Business Standard | Frequent × medium | Confirms offline-first: **no live round-trips for verify or pay at peak**; batch sync is correct | (core, validated) |
| **Tout/bulk-hoarding + fraudulent IDs** (TTD: 545 users → 14,449 tickets; one booked 225) | Deccan Chronicle | Frequent × high | **Identity-bound booking + per-person caps + bulk detection**; the QR doesn't stop touts at booking | **C13** |
| **Six colour-coded e-pass categories** (VIP/Akhara/vendor/media/police/emergency) | ANI, Oneindia, India TV | Always × low | Extend `slot_type` to **category-coded passes** with distinct colour + dedicated lanes (not just public/vip) | C3 (+extend) |
| **Simhastha 2028: 18 approach-road sites, 29-km Shipra stretch, organised parking + pedestrian corridors** | IANS/newkerala (planned) | Planning | Zones/checkpoints map to **~18 sites** (not 7); model the **park→ghat pedestrian leg** (drop-off vs park) | scope |

### What the evidence did NOT support (be honest in the pitch)
The verification pass found **no citable evidence** for several in-scope scenarios — so we
must treat these as **assumptions to validate with the administration**, not facts:
family separation, lost-vehicle location, low-digital-literacy / feature-phone / IVR usage
rates, ambulance access *through* gridlock, checkpoint staffing/shift-handover, DPDP-Act
number-plate surveillance specifics, and refund/no-show dispute handling. They are real and
important; we just shouldn't claim research backing we don't have. (Open questions carried
to §7.)

### Re-ranking §5 by frequency × danger (research-informed)
The research **raises two priorities** above their original slot:
- **Lockdown safety & execution** (C2/C7) is now clearly the #1 item — it's the single most
  validated, highest-danger finding (Mauni Amavasya). Keep it #1, and add the
  **"meter, don't slam shut + don't trap"** requirement to it.
- **Anti-tout identity binding** (C13) jumps to a top-3 pilot-blocker — it's *frequent and
  proven*, and it's the same identity layer as C10, so they should ship together.

Net revised order: **(1) Auth + commander identity + two-person lift + meter-not-slam
[C2,C3,C7]; (2) Identity-bound booking with caps + phone-OTP pass retrieval [C13,C10];
(3) Unify capacity + no-show + exit + buffer/holding [C4,C5,C6]; (4) Replace bay-picker w/
real lot view [C1]; (5) edge hardening [C8,C9,C11,C12].**

---

## 7. Top requirements teams typically get wrong (closing)

Grounded in both the code audit and the research — the things a *smart/secure/reliable/
durable* VMS must satisfy that builders usually miss:

1. **The kill switch must be the hardest-to-misuse, easiest-to-reach action** — protected
   identity + two-person *lift*, yet a no-system physical deny-all floor. Today it's the
   opposite (C2).
2. **Meter inflow; never create a bottleneck.** A closure or "zone full" must redirect/hold,
   not trap — the stampede was worsened by sudden closure + contraflow.
3. **Identity at the booking layer, not just crypto at the gate.** Forgery-proof passes do
   nothing about touts; cap per identity (C13).
4. **Honest capacity.** Don't sell more valid passes than you can physically honor without a
   governed overbook + refund/redirect policy (C4).
5. **Offline-first means offline-*durable*** — server-side pass retrieval (not localStorage),
   trusted time, signed node identity, delta sync (C8–C12).
6. **Don't show precision you can't honor.** Kill the fictional bay-picker; lot-level + live
   signage is the truth (C1).
7. **Design for the un-appable.** SMS/IVR/feature-phone + walk-in handling as first-class —
   *validate the real usage rates with the administration* (evidence gap, §6).
