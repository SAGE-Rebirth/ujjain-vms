# Ujjain VMS

Offline-first vehicle-entry **booking + checkpoint** platform for peak-load events
(Simhastha 2028 / VIP movement) in Ujjain, MP. A citizen verifies their phone, books a
parking slot (BookMyShow-style), and gets a cryptographically signed QR **bound to
their number plate** with an assigned parking lot + Navigate map. A Raspberry-Pi-class
gate verifies it **with zero internet** — checking the plate, assigning/overflowing the
lot, denying duplicates, and enforcing an emergency lockdown while offline. Commanders
hold a **two-person** kill switch; bookings are **capped per phone** to stop touts.

**TL;DR:** `./scripts/run.sh` → open http://127.0.0.1:5173 → follow the demo in
[docs/USAGE.md §2](./docs/USAGE.md#2-the-5-minute-pitch-demo-claudemd-12).

## Documentation

| Doc | What's in it |
|-----|--------------|
| [docs/SETUP.md](./docs/SETUP.md) | Install (venv + node_modules, no system pollution), run, configure, reset, troubleshoot |
| [docs/USAGE.md](./docs/USAGE.md) | The three screens + the exact 5-minute pitch demo script + talking points |
| [docs/FAQ.md](./docs/FAQ.md) | How it works online/offline, gate verifying an unsynced pass, concurrency/holds, operator states |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Process topology, trust model, auth/identity, lots, batch sync, lockdown, data model |
| [docs/API.md](./docs/API.md) | Every central + checkpoint-node endpoint (auth, booking, sync), with request/response shapes |
| [docs/DESIGN-v2.md](./docs/DESIGN-v2.md) | Plate-binding + lot-reassignment design, with two adversarially-verified research passes |
| [docs/AUDIT.md](./docs/AUDIT.md) | Whole-system conflicts analysis vs smart/secure/reliable/durable — resolved vs open |
| [docs/REVIEW.md](./docs/REVIEW.md) | Original multi-agent review: what was fixed + the Phase-1 hardening list |

See also [`CLAUDE.md`](./CLAUDE.md) — the product brief / pitch spec (14 sections).
