# Ujjain Vehicle Management System (VMS)
### A booking + checkpoint platform for peak-load vehicle entry during religious events and VIP movement
**Prepared for:** Govt. of Madhya Pradesh / Ujjain Smart City pitch — prototype build via Claude Code
**Author:** Abhinav Pavithran
**Status:** v1 brief — feed this whole file to Claude Code as the seed document (see Section 12)

---

## 1. Problem statement

Ujjain sees extreme, spiky vehicle inflow during religious events (Simhastha being the ceiling case — administration is planning around 2.5 crore devotees on peak bathing days) and routine VIP movement year-round. Two things are true at the same time during these peaks:

1. **Demand for parking/entry slots is bursty and predictable in advance** (event calendar, VIP schedules) but **chaotic in the moment** (people don't follow plans).
2. **Network and power become unreliable exactly when load is highest** — the same crowd density that creates the traffic problem also saturates local cell towers and strains power at temporary checkpoints.

Any system that assumes "the internet will be up when I need it most" will fail at the exact moment it matters. That has to be the design constraint, not an edge case.

## 2. Ground truth — what Ujjain/MP is already building

This matters because your system should **plug into** this, not duplicate it:

- MP is building a unified digital platform for Simhastha 2028 using PM Gati Shakti + BISAG-N geospatial data, covering routes, parking, traffic and access points across a ~250km radius, aggregating multiple data sources via APIs into one interface.
- A command centre is planned with 10,000+ CCTV cameras, smart parking with real-time seat availability, and shuttle routing.
- The fair ground is being split into 7 self-contained zones, each with its own parking, to prevent any single chokepoint.
- Temporary parking is being built along the main approach roads (Indore Road, Dewas Road, Unhel Road, Badnagar Road, Agar Road, Maksi Road) — these are your likely checkpoint sites.
- MP signed with Google Cloud for an AI "Sahayak" app for crowd/navigation/emergency alerts in multiple languages.
- **Key precedent from Maha Kumbh 2025 (Prayagraj):** after the Mauni Amavasya stampede, the administration's emergency move was to instantly cancel *every* vehicle pass — including VVIP — and declare the whole fair area a no-vehicle zone, with the decision implemented by people physically on the ground, not from a control room dashboard.

**Implication for your pitch:** You're not proposing a replacement for the geospatial/AI platform being built — you're proposing the **vehicle-entry booking + checkpoint-execution layer** that plugs into it. That's a realistic, fundable, well-scoped ask, and it directly complements the existing plan instead of competing with it.

## 3. Design philosophy

Three rules, in order of priority:

1. **A checkpoint must be able to admit, deny, and log a vehicle with zero internet, indefinitely.** Connectivity is an optimization, not a dependency.
2. **Anyone with authority (police, zone commander) must be able to revoke all bookings and force a lockdown instantly, and that revocation must propagate even offline** (this is the Mauni Amavasya lesson — a digital system that needs the internet to *stop* admitting vehicles is dangerous).
3. **Budget-friendly means reuse, not rebuild.** Every component should map to something already procured or trivially procurable (existing phones, existing 4G dongles, existing police manpower, ₹3000-class Raspberry Pi boards) — no bespoke hardware that needs a tender cycle.

## 4. System architecture

```
                         ┌────────────────────────────┐
                         │   CENTRAL COMMAND DASHBOARD  │
                         │  (cloud, used when reachable)│
                         │  - capacity planning         │
                         │  - zone/slot configuration    │
                         │  - VIP schedule management    │
                         │  - analytics & reconciliation │
                         │  - LOCKDOWN BROADCAST button  │
                         └─────────────┬────────────────┘
                                       │ syncs opportunistically
                                       │ (batched, not real-time)
                 ┌─────────────────────┼─────────────────────┐
                 │                     │                     │
        ┌────────▼─────────┐  ┌────────▼─────────┐  ┌────────▼─────────┐
        │ CHECKPOINT NODE 1  │  │ CHECKPOINT NODE 2  │  │ CHECKPOINT NODE N  │
        │ (Indore Rd entry)  │  │ (Dewas Rd entry)   │  │ (...)              │
        │ - Raspberry Pi/    │  │                    │  │                    │
        │   cheap mini-PC    │  │                    │  │                    │
        │ - local SQLite     │  │                    │  │                    │
        │   booking cache    │  │                    │  │                    │
        │ - offline QR        │  │                    │  │                    │
        │   verification     │  │                    │  │                    │
        │ - works standalone  │  │                    │  │                    │
        └─────────┬──────────┘  └────────────────────┘  └────────────────────┘
                  │  (optional LoRa/WiFi mesh between adjacent checkpoints)
                  │
        ┌─────────▼──────────┐
        │  CITIZEN BOOKING    │   ← the "BookMyShow"-style layer
        │  APP / WEB / IVR     │
        │  - pick date+zone     │
        │  - pick slot+vehicle  │
        │  - pay (UPI)          │
        │  - get signed QR       │
        │  - SMS fallback for     │
        │    low-end phones        │
        └────────────────────────┘
```

## 5. Citizen booking flow (the "BookMyShow" layer)

This is the part the public touches. Mirror the BookMyShow mental model exactly, because people already know how to use it — don't innovate on UX here, innovate on the backend.

**Flow:**
1. **Pick event/date** — e.g. "Simhastha — 14 Jan, Shahi Snan" or "Regular darshan — any day."
2. **Pick entry zone** — map view of the 7 zones / approach roads, each showing live (or last-synced) capacity as a fill bar, exactly like a "seats available" indicator.
3. **Pick a time slot** — 30/60-minute arrival windows, like a movie showtime grid. This is the single most important UX borrowing from BookMyShow: **slot the demand, don't let it free-for-all**.
4. **Pick vehicle type & count** — 2-wheeler / car / bus, since parking footprint differs.
5. **Pay** — UPI (cheapest, most universal rail in India; no new payment infra needed).
6. **Receive a signed QR ticket** — this QR is **self-contained and offline-verifiable** (see Section 8). It also gets sent via SMS as a fallback (a 6-character alphanumeric code that a checkpoint operator can type in manually if the QR scanner or the visitor's phone fails).

**Admin side (zone/event managers):**
- Set total capacity per zone per slot (this is literally inventory management, same primitive as "seats per showtime").
- See booked vs. available vs. arrived-and-verified counts.
- Trigger overflow rules (e.g., auto-redirect new bookings to the next zone once one fills).

## 6. Checkpoint operations — the part that has to survive no internet

A checkpoint operator (could be a constable with a phone, or a small kiosk) needs to do exactly one thing reliably: **decide admit or deny in under 5 seconds, with or without signal.**

**How offline verification works (no internet needed at the moment of scanning):**
- Every booking QR is signed server-side with a private key at issuance time (Ed25519 or HMAC) and encodes: booking ID, zone, date, time-slot window, vehicle type, and a short validity window.
- The checkpoint device holds the **public key** (or a shared secret, if HMAC) baked in at setup — it never needs to phone home to verify a signature. This is the same trust model as a boarding pass barcode or an offline movie ticket scanner: cryptographic proof is in the ticket itself.
- The checkpoint also holds a **locally cached copy of all bookings for that zone/date**, pulled down during the last time it had connectivity (could be hours earlier, at 2am, over whatever weak signal was available — even a single successful sync per day is enough). This catches duplicate-use and lets it work even if the QR's crypto check alone isn't enough (e.g. revoked bookings, no-show flags).
- Every admit/deny decision is appended to a local log (SQLite). Nothing is lost if the network never comes back that day.

**When connectivity does appear** (even for 30 seconds, even at 2G speeds): the node does a **batch sync**, not a live call — uploads its log, downloads any new bookings/revocations. This mirrors how FASTag toll plazas already operate in production: transactions are batched and sent up at intervals rather than requiring a live round-trip per vehicle. You are not proposing anything riskier than what NHAI already runs nationally.

**The lockdown button:** Central command has a "revoke everything, zone X" or "revoke everything, all zones" action. This propagates the same way — next sync, every checkpoint pulls it down and stops admitting. But because that's not instant if a node is offline, **the physical fallback must always exist too**: a checkpoint operator can manually flip to "deny all" without any system input at all, because ultimately a human with a barrier is the real kill switch. The system should make that decision easy and loggable, not be a single point of failure for it.

## 7. VIP / priority vehicle handling

- VIP movements are scheduled in advance (known motorcades, known timing windows) — treat them as a **reserved-capacity slot type**, not a separate system. Same booking primitive, different priority flag and a dedicated lane assignment.
- VIP passes get the same signed-QR + offline-cache treatment — **no exceptions**, because the Prayagraj precedent shows VIP passes are exactly the thing that gets revoked first in a crisis, and your system needs to be able to do that as easily as revoking a public booking.
- Practically: a separate, visually distinct QR/sticker color and a dedicated lane at each checkpoint, but the backend treats it as "slot type = VIP" in the same table.

## 8. Why this is budget-friendly and procurement-easy

| Need | What we use | Why it's cheap/easy |
|---|---|---|
| Checkpoint compute | Raspberry Pi 5 / any ₹3-6k mini-PC | Already in your toolkit, no tender for custom hardware |
| Checkpoint connectivity | Existing 4G dongles / police wireless / Wi-Fi hotspot, used opportunistically | No new ISP contracts; it's a "best effort" link, not a guaranteed SLA |
| Payments | UPI | Zero new payment infrastructure, citizens already have it |
| Ticket medium | QR + SMS fallback | No new hardware for citizens; works on ₹2,000 phones via SMS |
| Checkpoint-to-checkpoint backup link | Wi-Fi mesh / optional LoRa modules (~₹1,500/node) | Only needed if you want zone-to-zone coordination without going through the cloud at all; entirely optional add-on |
| Database | SQLite at the edge, Postgres centrally | Free, battle-tested, zero licensing |
| Dashboard hosting | Any cheap VPS or the state's existing Smart City cloud | Reuses infra Ujjain Smart City already has rather than new procurement |

Nothing here requires a custom tender, an exclusive vendor contract, or hardware that doesn't already have a local supply chain in MP.

## 9. Admin / command center dashboard

Three screens, deliberately minimal for a prototype:
1. **Capacity planner** — set slots/capacity per zone per event date.
2. **Live operations view** — per-zone booked / arrived / no-show counts, pulled from whatever checkpoints have last synced (with a visible "last synced X minutes ago" indicator per node — **never hide staleness**, that's a safety feature, not a UX flaw).
3. **Lockdown control** — the revoke-everything action, with a confirmation step and a full audit log of who triggered it and when.

## 10. Phased rollout (what to actually pitch)

- **Phase 0 (this prototype):** Software-only simulation — booking web app, one simulated checkpoint node, the sync logic, the lockdown logic. Runs entirely on a laptop. This is what proves the concept to the government without asking for a single rupee of hardware yet.
- **Phase 1 (pilot):** 1–2 real checkpoints on a normal high-footfall day (regular Mahakal darshan traffic, not Simhastha scale) — real Raspberry Pi nodes, real QR scanning, real UPI payments.
- **Phase 2 (event scale):** Roll out to all approach-road checkpoints ahead of a major event, integrated with the state's existing Simhastha 2028 command centre and Sahayak app as a data source/sink, not a rip-and-replace.

## 11. Tech stack for the prototype

- **Booking web app:** React (or plain HTML/JS to keep it dependency-light) + a lightweight backend (FastAPI/Flask) — easy for Claude Code to scaffold fast, easy for you to extend given your AWS/K8s background later.
- **Checkpoint node simulator:** Python service with local SQLite, a signed-QR verifier, and a sync client — designed so the *same code* could later run on an actual Raspberry Pi 5.
- **Sync protocol:** simple "push log, pull delta" batch endpoint — no exotic CRDT machinery needed at prototype scale; that's a Phase 2+ optimization if conflict rates demand it.
- **Signing:** Ed25519 via a standard crypto library — small, fast, well understood, no proprietary dependency.
- **Everything runs in a Python virtual environment** so nothing touches your Mac's system Python — see Section 13.

## 12. Prototype scope — what we'll actually ask Claude Code to build first

Keep the MVP narrow enough to demo convincingly in one sitting:

1. Booking web app: pick zone → pick slot → pick vehicle type → fake-pay → get a signed QR + SMS-style code.
2. A "checkpoint simulator" screen: scan/enter the code, verify offline (toggle a "network: OFF" switch in the UI to *prove* it still works), log the decision.
3. A tiny admin dashboard: set capacity, watch bookings fill a slot, see arrived vs booked, hit "lockdown" and watch the checkpoint simulator immediately start denying everything even with network OFF.
4. A sync demo: flip network back ON, watch the checkpoint's offline log get pushed up and the dashboard update.

That one flow — book → go offline → verify at checkpoint → lockdown still works offline → reconnect → sync — **is the entire pitch**, demonstrated end to end in under five minutes.

## 13. Running the prototype safely (no system pollution on your Mac)

Give Claude Code this constraint explicitly, every time:

```bash
# Always create and use a project-local virtual environment.
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Run everything (backend, checkpoint simulator, sync worker) from inside this venv.
# Never pip install --user or install anything system-wide.
```

If you want even stronger isolation, ask Claude Code to wrap the whole thing in Docker Compose instead (one container for the booking backend, one for the checkpoint simulator, one for the dashboard) — that way nothing touches the Mac at all beyond Docker itself, and it also doubles as a believable "this is how it'd run on real edge hardware" demo for the pitch.

## 14. Open questions to flag to the government during the pitch (don't pretend these are solved)

- Who has legal authority to trigger a full lockdown, and what's the chain of command if the digital system and the physical authority disagree in the moment?
- How does this reconcile with the existing Sahayak/Google Cloud platform once that's live — data ownership, API contracts, who's the source of truth for capacity numbers?
- What's the actual SLA being assumed for "opportunistic connectivity" at checkpoints — is even occasional 2G guaranteed, or should the design assume total blackout for hours at a time?
- Refunds/no-show policy for bookings that can't be honored due to dynamic zone closures.

---

## How to use this file inside Claude Code

1. Save this file as `CLAUDE.md` (or keep this filename and reference it) at the root of a new project folder.
2. Open that folder in Claude Code.
3. Your first message to Claude Code should be something like:

   > Read CLAUDE.md. Build the Phase 0 prototype described in Section 12, in the tech stack from Section 11. Use a Python virtual environment per Section 13 — never install anything outside `.venv`. Build it incrementally: booking flow first, then checkpoint simulator with an offline toggle, then the admin dashboard with the lockdown button, then the sync demo. Show me each piece working before moving to the next.

4. Once it's running, the demo script for the government pitch is exactly the 5-step flow in Section 12 — book, go offline, verify, lockdown-while-offline, reconnect-and-sync.

This brief is intentionally the *whole* spec — architecture, rationale, budget framing, and rollout story — so it can also double as the first few pages of your actual government pitch deck, with the system diagram in Section 4 as your hero slide.