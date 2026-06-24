# VMS — Review & Hardening Notes

Multi-agent review (code reliability · security · solution-architecture vs
`CLAUDE.md` · frontend/performance) run against the live prototype. This records
what was found, what was **fixed**, and what is **deliberately deferred** to
Phase 1 so the government pitch has an honest hardening list.

## Fixed in this prototype

| ID | Area | Issue | Fix |
|----|------|-------|-----|
| C1 | Reliability | Overbooking race — non-atomic check-then-insert let concurrent bookings exceed slot capacity | `BEGIN IMMEDIATE` transaction around capacity check + insert (`central/app.py` `create_booking`) |
| M1 | Reliability | Checkpoint `verify()` upsert wrote blank `code`/`vtype`, breaking the operator fallback-code path and emergency exemption for soft-green admits | Store deterministic `human_code(bid)` + real `vtype`/`slot_type` (`checkpoint/node.py` `verify`) |
| L2 | Reliability | QR/sign done after DB commit → orphaned booking on failure | Sign + render QR before the write |
| §9.5 | Spec | Lockdown didn't revoke existing bookings (revoked count stuck at 0) | Lockdown flips in-scope `booked`→`revoked`; lift restores (`set_lockdown`/`clear_lockdown`) |
| §9.1 | Spec | Capacity planner was view-only | `POST /api/admin/capacity` + per-zone editor in the dashboard |
| §7 | Spec | VIP slots bookable only via curl | Public/VIP toggle in citizen booking; VIP badge on ticket |
| §5.6 | Spec | No SMS fallback | Simulated SMS text returned on booking and shown as an SMS bubble |
| FE-1 | Frontend | Tailwind via CDN → unstyled UI offline (contradicts the offline-first pitch) + FOUC | Tailwind compiled into the bundle (PostCSS); CDN removed |
| FE-2 | Frontend | Admin/checkpoint views didn't auto-refresh → looked dead on stage | Interval polling (admin 5s, checkpoint 3s) |
| FE-4 | Frontend | Stale slot availability after booking | Re-fetch slots after a booking |
| FE-5 | Frontend | Toggle race on null status | Disable toggles until status loaded; clear errors per action |
| H1 | Security/Reliability | Arrival-window/expiry never enforced | Window check implemented, env-gated `ENFORCE_WINDOW=1` (off by default so 2028-dated demo verifies today) |

> **Update (post-review work):** several items below have since been **built** —
> see [`AUDIT.md`](./AUDIT.md) (whole-system conflicts + status) and
> [`DESIGN-v2.md`](./DESIGN-v2.md) (plate binding, lot reassignment). Resolved since
> this review: **authentication** on admin + sync (✅, node-local kill-switch routes
> left open by design), **emergency-class self-issue** (✅ restricted to
> dispatcher/commander), **two-person lockdown lift** + cause-tagged revocations (✅),
> **identity-bound booking with per-phone caps** + server pass retrieval (✅),
> **plate binding** into the signed pass (✅), **gate-side overflow redirect** across
> lots (✅), and a **citizen map + Navigate** deep-link (✅). Still open below:
> CORS, no-show counting, true delta sync, admin geographic map, capacity unification.

## Deferred to Phase 1 (documented, not blocking a loopback laptop demo)

These are **safe for a Phase-0 demo on an isolated machine bound to 127.0.0.1**,
and are the explicit "before pilot" list (✅ = since implemented):

- ✅ **Authentication / authorization.** *Done:* HMAC bearer tokens on `/api/admin/*`
  (commander/staff) and `/api/sync/*` (per-node token). The node control routes
  (`/network`, `/denyall`) stay unauthenticated **by design** — the physical kill-switch
  floor (bind to an ops VLAN in the field). (Security C1)
- **CORS.** `allow_origins=["*"]` on both services → restrict to the operator
  console origin. (Security C2 — still open)
- **Booking-enumeration + fallback-code strength.** `/api/sync/snapshot` is now
  node-authenticated; `/api/bookings/{id}` is still open and the 6-char code is
  deterministic. Phase 1: random stored code, rate-limit `/verify`. (Security H2/H3 — partial)
- ✅ **Emergency-class bookings.** *Done:* issuing `vtype=emergency` now requires a
  dispatcher/commander token; the public can no longer self-issue. (Security M3)
- **Private key at rest** is raw bytes on disk; fine on a single demo host, must
  be `0600` + encrypted/HSM and never co-located on checkpoint hosts in prod.
  (Security M1)
- **Sync ingest bounds** — `/api/sync/logs` is now node-authenticated, but still
  trusts node-supplied decisions and doesn't cap `events`/`assignments` length.
  Phase 1: bound payload size, treat decisions as audit claims. (Security M2 — partial)
- **Offline same-zone replay** is an architectural property of offline-first: a
  freshly-issued ticket unseen since last sync is admitted "soft-green" and can't
  be dedup'd until sync. Mitigations: short validity window (`ENFORCE_WINDOW`),
  plate binding, loud duplicate-flagging at reconcile. Disclose as an accepted
  constraint. (Security H1)
- ✅ **Overflow redirect.** *Done at the gate* — a full parking lot overflows down the
  zone's named cascade (DESIGN-v2 §9). Zone-to-zone redirect *at booking time* once a
  whole zone fills is still a Phase-1 admin rule.
- ✅ **No-show counting.** *Done:* a commander "Reconcile no-shows" action marks
  un-arrived past-window bookings `noshow` and reclaims their capacity (AUDIT C6); a
  gate-out exit frees the lot space (C5).
- ✅ **True delta sync.** *Done:* the pull is now a cursor-based delta (`updated_at`),
  upserting only changed bookings instead of a full-snapshot replace (AUDIT C12).
- **Geographic map** — the *citizen* pass now has a real OSM map + Navigate deep-link
  to its lot; the *admin* zone grid → Leaflet/OSM map remains the Phase-1 swap.

## What is solid and demo-ready

Core CLAUDE.md §12 flow verified end-to-end: book → signed QR + code → network
OFF → gate admits offline (signature only) → re-scan denied as duplicate offline
→ lockdown propagates + gate denies even offline → manual deny-all kill switch →
reconnect → batch sync pushes the log up and updates the dashboard. SQL is fully
parameterized (no injection). venv / no-system-pollution constraint holds.
