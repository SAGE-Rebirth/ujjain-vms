# Usage Guide — Ujjain VMS

How to actually *use* the prototype: the three screens, and the exact 5-minute
demo script for the government pitch.

Prereq: it's running (`./scripts/run.sh`) and you have
**http://127.0.0.1:5173** open. If not, see [SETUP.md](./SETUP.md).

The top bar has a **date selector** (seeded event days) and three tabs:
**🎟️ Book Slot** (citizen) · **🚦 Checkpoint** (gate) · **🛰️ Command Centre** (admin).

---

## 1. The three screens

### 🎟️ Book Slot — the citizen app (BookMyShow-style)
0. **Verify your mobile** — enter a 10-digit number → an **OTP** (shown on screen
   in the demo) → verify. This is the anti-tout identity anchor (bookings are capped
   per phone) and the key to retrieving passes on any device.
1. **Pick entry zone** — a grid of the 7 approach-road zones with capacity fill bars.
2. **Public / VIP toggle** — switch the window list between public and the VIP lane.
3. **Pick an arrival window** — hourly "showtimes"; full windows struck out.
4. **Vehicle, count & number plate** — 2-wheeler / car / bus, a count, and the
   **vehicle number plate** (bound into the pass) + optional colour/model.
5. **Pay via UPI (mock)** — a short fake-payment delay, then the ticket.
6. **Ticket** — a scannable **QR**, a **6-char code**, a **simulated SMS**, the
   **assigned parking lot** with an **OpenStreetMap view + 🧭 Navigate** deep-link,
   and (VIP) a VIP badge. **My Passes** loads from the server keyed to your phone.

### 🚦 Checkpoint — the gate console
- **Gate scanner** — optionally type the **observed number plate**, then paste a QR
  `token` (or the 6-char `code`) → a big **green ADMIT** / **red DENY** banner. ADMIT
  shows the **plate to check** and the **lot to direct the vehicle to** (with an
  *overflow* badge if redirected); tagged **decided OFFLINE** when the link is down.
  If the typed plate ≠ the pass plate → **DENY — plate mismatch**.
- **Reassign lot** — on an admit, send the vehicle to a different lot (manual override).
- **Parking tab** — live per-lot occupancy bars in cascade order.
- **Network link** toggle — cut it and the gate keeps working.
- **Manual deny-all** — the physical kill switch; denies everything instantly.
- **Sync now** — batch push log + assignments up, pull bookings/lockdowns/lots.
- **Local cache** panel + **Recent decisions** log. Auto-refreshes ~3s.

### 🛰️ Command Centre — the admin dashboard *(commander login required)*
- **Sign in** — `commander.a` / `commander.b` (password `simhastha28`).
- **Lockdown control** — `⚠ Lockdown ALL zones` (single-commander confirm) or per-zone
  lock. **Lifting needs a second commander** to authenticate in the modal (two-person
  rule). Active lockdown turns the panel red.
- **Live operations** — per zone: booked / arrived / capacity, lock state, and a
  **"sync X ago"** staleness indicator. Auto-refreshes ~5s.
- **Capacity planner** — rewrite every slot's capacity for a zone/date.
- **Audit log** — who triggered what, when (real identities; two-person lifts named).

---

## 2. The 5-minute pitch demo (CLAUDE.md §12)

This is the whole story, end to end. Do it in order.

> Tip: keep the **Checkpoint** and **Command Centre** tabs handy; you'll switch
> between them. Start from a clean state (`rm -f data/*.db` then restart) if you
> want pristine numbers.

**① Book (🎟️ tab)**
- **Verify your mobile** — any 10-digit number, then the on-screen **OTP**.
- Pick **Indore Road**, an arrival window, **Car**, enter a **number plate**, pay
  (mock UPI).
- You get a **QR + 6-char code + SMS + assigned lot + Navigate map**. *Copy the QR
  token / note the code and plate.*
- Optional: flip the **VIP** toggle and book a VIP-lane pass too. (Booking the same
  phone past the cap → a "booking limit reached" message — the anti-tout guard.)

**② Go offline (🚦 tab)**
- Hit the **network toggle** → it reads **OFFLINE**.
- (If this gate hasn't synced yet, click **Sync now** *before* going offline so it
  has the public key + booking cache.)

**③ Verify at the checkpoint (🚦 tab, still OFFLINE)**
- Paste the token (or type the code) → **ADMIT**, tagged **decided OFFLINE**.
- Scan the **same** ticket again → **DENY — already used (duplicate)**, still
  offline. *Duplicate detection without any network.*
- Book a **new** ticket in the 🎟️ tab while the gate is offline, then verify it →
  **ADMIT (soft-green)** — the gate trusts the signature for a ticket it hasn't
  seen since its last sync.

**④ Lockdown while offline (🛰️ then 🚦)**
- In the **Command Centre**, sign in as **commander.a**, hit **⚠ Lockdown ALL zones**
  → confirm. Watch the panel go red; bookings are **revoked**.
- The instant, offline path: back in the **Checkpoint** tab (still OFFLINE), flip
  **Manual deny-all** → now **every** vehicle is **DENIED**, even offline.
  (An `emergency` vehicle stays **ADMITTED** — the exemption.)
- Turn deny-all off; **Sync now** with the network back on and the lockdown
  propagates into the gate's cache so it denies from the synced lockdown too.

**⑤ Reconnect, sync & two-person lift (🚦 then 🛰️)**
- Flip the gate **ONLINE** and click **Sync now** → the offline scan log flushes
  up (`pushed: N`), `pending_unsynced` drops to **0**.
- Switch to the **Command Centre** → the zone's **arrived** count has ticked up
  and **"sync … ago"** is fresh (it auto-polls).
- **Lift the lockdown** → the modal asks for a **second commander** (`commander.b`)
  to approve. That's the two-person rule — re-opening takes two people.

That single arc — **book → offline → verify → lockdown-still-works-offline →
reconnect-sync** — is the entire pitch.

---

## 3. Driving it without the UI (HTTP)

Every screen bottoms out in the API ([API.md](./API.md)). Handy for scripted
demos or a quick smoke test:

```bash
D=2028-04-27
H='Content-Type: application/json'
PY=./.venv/bin/python
jq() { $PY -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }

# 1) citizen phone-OTP → citizen token (booking is identity-bound)
OTP=$(curl -s -X POST localhost:8000/api/auth/otp/request -H "$H" -d '{"phone":"9876543210"}' | jq demo_otp)
CIT=$(curl -s -X POST localhost:8000/api/auth/otp/verify  -H "$H" -d "{\"phone\":\"9876543210\",\"code\":\"$OTP\"}" | jq token)

# 2) book (auth + plate) -> token, code, qr, sms, lot
BK=$(curl -s -X POST localhost:8000/api/bookings -H "$H" -H "Authorization: Bearer $CIT" \
      -d "{\"slot_id\":\"indore-$D-06:00\",\"vtype\":\"car\",\"plate\":\"MP09AB1234\"}")
TOKEN=$(echo "$BK" | jq token)

# 3) sync the node (sends its own token), go offline, verify with the plate
curl -s -X POST localhost:8001/sync >/dev/null
curl -s -X POST localhost:8001/network -H "$H" -d '{"on":false}'
curl -s -X POST localhost:8001/verify  -H "$H" -d "{\"token\":\"$TOKEN\",\"observed_plate\":\"MP09AB1234\"}"
# -> {"decision":"admit","offline":true,"lot_name":"P1 — Sugar Mill",...}

# 4) commander login → lockdown
CMDA=$(curl -s -X POST localhost:8000/api/auth/login -H "$H" -d '{"username":"commander.a","password":"simhastha28"}' | jq token)
curl -s -X POST localhost:8000/api/admin/lockdown -H "$H" -H "Authorization: Bearer $CMDA" \
     -d '{"scope":"ALL","reason":"demo"}'

# 5) reconnect + sync, then TWO-PERSON lift (second commander credentials)
curl -s -X POST localhost:8001/network -H "$H" -d '{"on":true}'
curl -s -X POST localhost:8001/sync
curl -s -X POST localhost:8000/api/admin/lockdown/ALL/lift -H "$H" -H "Authorization: Bearer $CMDA" \
     -d '{"second_username":"commander.b","second_password":"simhastha28"}'
```

---

## 4. Talking points while you demo

- **"The gate never needs the internet."** The QR is cryptographically signed;
  the gate verifies it with a public key it already holds — like a boarding pass.
- **"A copied QR is useless."** The pass is bound to one **number plate**; the gate
  checks it against the actual vehicle and burns the pass on first use.
- **"The kill switch is the hardest action, not the easiest."** Lockdown is
  commander-only; **re-opening takes two commanders** (the dangerous direction).
- **"One phone, fair access."** Bookings are capped per verified mobile number — the
  anti-tout guard (the Tirupati hoarding precedent).
- **"Lockdown works even when the network is down."** Two paths (synced revoke +
  the manual kill switch) and emergency vehicles stay exempt — the Maha Kumbh
  2025 lesson, built in.
- **"Staleness is shown, not hidden."** The command centre always says how long
  ago each gate synced — an operator should never mistake stale data for live.
- **"Budget-friendly by reuse."** Raspberry-Pi-class nodes, existing phones, UPI,
  existing 4G — no bespoke hardware, no tender cycle.
- **"This plugs into Simhastha 2028, it doesn't replace it."** It's the
  vehicle-entry booking + checkpoint layer for the existing ICCC / Sahayak
  platform.

For the whole-system conflicts analysis — what's been resolved (auth, two-person
lift, plate binding, identity caps, lot reassignment) vs. what's still open (capacity
unification, delta sync, trusted clock, real UPI), see [`AUDIT.md`](./AUDIT.md) and
[`DESIGN-v2.md`](./DESIGN-v2.md). Being upfront about the Phase-1 list is part of the pitch.
