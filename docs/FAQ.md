# FAQ & Behaviour Notes — Ujjain VMS

Plain-language answers to the questions that come up most, especially around the
offline model and concurrency. For the deeper design, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

## The 3 players

| Who | Device | Internet? |
|---|---|---|
| **Citizen** | their own phone | **Yes** — books from home/anywhere |
| **Central console** | cloud server | Yes — the single source of truth |
| **Gate** | cheap box at the road (Raspberry-Pi-class) | **Maybe not** — must survive offline |

Only the **gate** is allowed to be offline. Booking always happens online against
central, and the citizen first **verifies their mobile number** (OTP) — that identity
caps bookings per phone (anti-tout) and lets passes be retrieved on any device.

---

## How does the gate verify a pass if its database was never synced?

This is the key idea. **Authenticity does not come from a database lookup — it
comes from a signature on the QR**, like a signed cheque or an airline boarding
pass.

- Central holds a **private key** (a secret "stamp"). Only it can sign a pass.
- Every gate holds the matching **public key** (a "stamp-checker"). It can verify
  a stamp but can't forge one.
- The QR carries `DATA (booking-id, zone, slot, vehicle type, number plate, expiry)
  + SIGNATURE`. The **number plate is bound in**, so a photocopied QR only works on
  the one vehicle it was issued for (the operator eyeballs the plate at the gate).

So a pass you bought **5 minutes ago that this gate has never seen or synced**
still verifies and is admitted — the gate checks the signature with maths on the
device, no network needed. We call that a **"soft-green" admit** (valid signature,
not yet in the local cache); it's flagged to reconcile at the next sync.

**What the local cache (database) is actually for** — only two things, both
optional for basic authenticity:
1. **Duplicate detection** — the same valid pass used twice (the gate remembers
   what it already admitted, even offline).
2. **Cancellation/lockdown** — passes central revoked.

If a gate *never* syncs, it loses only those two checks. The safety net for
cancellations is the **manual deny-all kill switch** — the operator stops all
entry instantly with zero system, no internet.

> **Signature = "is this real?"** (offline, always). **Database = "used or
> cancelled?"** (better when synced, optional).

---

## How does offline data sync between the gate and central?

Not a live connection — an **opportunistic batch** exchange (the FASTag model).
Whenever *any* link appears (even 30 seconds of 2G):

```
gate SQLite  ──push scan log──►  central     (POST /api/sync/logs)
gate SQLite  ◄──pull snapshot──  central     (bookings + lockdowns)
```

One successful sync a day is enough. Between syncs each side accumulates changes;
when a link appears they reconcile (eventual consistency). Transport for that
occasional sync is anything cheap/existing: a 4G dongle, police wireless, a phone
hotspot, an optional LoRa mesh to a neighbouring gate, or worst-case sneakernet.

---

## Two people try to book the same slot at the same time — what happens?

**Booking is always online against central, so the gate's offline state is
irrelevant here.** Central handles simultaneous requests **one at a time** with a
database lock (`BEGIN IMMEDIATE`):

1. A and B both hit Pay on the last open spot at the same instant.
2. Central locks the slot → A's booking commits → **A gets the pass (200)**.
3. B's request runs next, sees the slot full → **B is rejected with `409 slot
   full`** (no charge, no pass).

There is **no window** where both succeed — capacity can never be oversold.
(Verified: capacity 3, fired 12 concurrent bookings → exactly 3 succeeded.)

### Where do you actually park? Lots, not numbered bays.

A booking is tagged with an **intended parking lot** (the zone's primary), shown on
the pass with a map + Navigate link. But the **physical lot is decided at the gate**:
the node admits into the booked lot if it has room, otherwise **overflows down the
zone's named cascade** (P1 full → P2 → P3 — the real Kumbh model), and the operator
can **manually reassign** a vehicle that parked elsewhere. The lot is *not* in the
signed pass — it's mutable operational data — so it can change without breaking the
signature. Full rationale + the two research passes behind this: [DESIGN-v2.md §9](./DESIGN-v2.md).

The booking wizard's **Parking** step now shows the zone's **real lots** with live fill
(the old cosmetic numbered-bay grid was removed — AUDIT C1 resolved).

**Booking races are still safe:** nothing is reserved until you **Pay**, and
`create_booking` runs the capacity check + insert inside `BEGIN IMMEDIATE`, so a slot can
never oversell — whoever pays first wins; the loser gets `409 slot full`.

**Honest capacity (C4):** a zone also can't sell more passes than its lots can physically
hold, beyond a small overbook for no-shows (`OVERBOOK_RATIO`); past that you get
`409 zone parking sold out`. No-shows are reclaimed (command "Reconcile no-shows"), and a
gate-out exit frees the space, so occupancy stays a *current* count.

---

## What stops one tout from bulk-booking every slot? And what if I lose my phone?

Booking is **bound to a verified mobile number** (phone-OTP) and **capped per phone
per date** (default 3). That's the anti-tout control — real systems get gamed exactly
this way (at Tirupati, 545 users booked 14,449 tickets). Because the booking is tied
to your number, **My Passes loads from the server** keyed to your phone: clear your
browser or switch to a new phone, re-verify the same number, and your passes (QR and
all) come back. It no longer lives only in one browser's `localStorage`.

## Who can do what? (authentication)

- **Citizens** verify a phone (OTP) to book and view their passes.
- **Commanders** sign in to the Command Centre; only they can lock down or edit
  capacity, and **lifting a lockdown needs two distinct commanders**.
- **Dispatchers/commanders** are the only ones who can issue **emergency** passes
  (the public can't self-issue a lockdown-exempt pass).
- **Nodes** authenticate their sync uploads with a per-node token.
- The node's **physical deny-all / network** controls are deliberately *not* behind a
  login — they are the human-with-a-barrier floor that must work with zero system input.

## Why does the Gate Operator show "offline" / its buttons are dead?

Almost always: **the gate node (port 8001) isn't running.** The console polls that
device for status; with no device answering it can't load anything, so it disables
the controls. The UI distinguishes two states:

- **"offline · link cut"** — the gate device *is* running, but its uplink to
  central is deliberately cut (the demo toggle). Controls still work — that's the
  whole point of offline operation.
- **"not connected"** — the gate *device itself* isn't answering (process down or
  wrong URL). Start it (see [SETUP.md](./SETUP.md#run-each-service-individually));
  the console reconnects automatically.

Also by design: the **Verify** buttons are disabled until you paste a QR token or
type a 6-char code — there's nothing to verify until then. The network / deny-all
/ sync controls live under the **Node** tab and are active once the node is up.

---

## Why don't I see API calls in the browser address bar?

It's a **single-page app** — the URL stays `…:5173` and never navigates. All API
calls happen in the background via `fetch` (AJAX), not in the address bar. To watch
them, open **DevTools (F12) → Network tab → filter "Fetch/XHR"**; you'll see calls
like `/api/zones`, `/api/bookings`, and `http://127.0.0.1:8001/verify`. Central
calls use the relative `/api` (proxied to :8000 in dev); the gate is called
directly at `127.0.0.1:8001`.
