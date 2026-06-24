# Setup — Ujjain VMS

Get the prototype running on a laptop. **Nothing is installed on the host
system** — all Python lives in a project-local `.venv`, all JS in a project-local
`node_modules`.

---

## 1. Prerequisites

| Tool | Version used | Notes |
|------|--------------|-------|
| Python | 3.11+ | for the venv |
| Node.js | 18+ (tested on 26) | for the Vite frontend build |
| npm | 9+ (tested on 11) | |

Check:

```bash
python3 --version
node --version
npm --version
```

No global pip/npm installs are required or performed.

---

## 2. One-time install

From the project root (`/Volumes/Work/data/projects/vms`):

```bash
# 1. Python backend — into a project-local venv only
python3 -m venv .venv
source .venv/bin/activate        # activate the venv (Windows: .venv\Scripts\activate)
pip install --upgrade pip
pip install -r requirements.txt

# 2. Frontend — into project-local node_modules only
cd frontend
npm install
cd ..
```

After `source .venv/bin/activate`, plain `python` / `pip` resolve to the venv —
your shell prompt shows `(.venv)`. Run `deactivate` to leave it. If you prefer
not to activate, call the binaries by path instead (e.g. `./.venv/bin/pip install
-r requirements.txt`); `scripts/run.sh` already uses explicit `.venv` paths, so it
works either way.

`requirements.txt` pins: `fastapi`, `uvicorn[standard]`, `pydantic`,
`cryptography` (Ed25519), `qrcode[pil]` (QR PNGs), `httpx` (node→central sync).

> Never use `pip install --user` or `npm install -g`. The venv + local
> `node_modules` keep the Mac's system Python and global packages untouched.

---

## 3. Run everything

```bash
./scripts/run.sh
```

This launches, all from inside `.venv` and local `node_modules`:

- **Central command** → http://127.0.0.1:8000
- **Checkpoint node** (`indore`) → http://127.0.0.1:8001
- **Frontend (Vite dev)** → http://127.0.0.1:5173  ← **open this**

`Ctrl-C` stops everything (the script traps and kills all child processes).

### Multiple checkpoint zones

```bash
CHECKPOINTS="indore dewas unhel" ./scripts/run.sh
# indore→:8001, dewas→:8002, unhel→:8003
```

The checkpoint console (Checkpoint tab) defaults to `:8001`; point it at another
node via the "checkpoint node URL" box at the bottom of that tab.

### Run each service individually

Prefer separate terminals (e.g. for debugging one service)? Start each from the
project root. Two equivalent styles — activate the venv once, **or** call the
binary by path.

**1 · Central command API** → http://127.0.0.1:8000
```bash
# with the venv activated (source .venv/bin/activate):
cd backend/central && uvicorn app:app --host 127.0.0.1 --port 8000

# or without activating — call the venv binary directly:
.venv/bin/python -m uvicorn app:app --app-dir backend/central --host 127.0.0.1 --port 8000
```

**2 · Checkpoint node** (one per zone) → http://127.0.0.1:8001
```bash
cd backend/checkpoint
ZONE_ID=indore CHECKPOINT_ID=cp-indore CENTRAL_URL=http://127.0.0.1:8000 \
  uvicorn node:app --host 127.0.0.1 --port 8001

# a second zone in another terminal — different ZONE_ID and port:
ZONE_ID=dewas CHECKPOINT_ID=cp-dewas CENTRAL_URL=http://127.0.0.1:8000 \
  uvicorn node:app --host 127.0.0.1 --port 8002
```

**3 · Frontend (Vite dev)** → http://127.0.0.1:5173  ← **open this**
```bash
cd frontend && npm run dev
```

Order doesn't matter — start them in any order; the frontend proxies `/api` to
central (`vite.config.js`) and calls the node directly. Stop each with `Ctrl-C`
in its terminal.

---

## 4. Production-style build (frontend served by central)

For a single-origin demo where FastAPI serves the built SPA (no separate Vite
process), and to confirm styling works fully offline:

```bash
cd frontend && npm run build && cd ..      # outputs frontend/dist/
# start central + node WITHOUT the vite line:
( cd backend/central && ../../.venv/bin/python -m uvicorn app:app --port 8000 ) &
( cd backend/checkpoint && ZONE_ID=indore ../../.venv/bin/python -m uvicorn node:app --port 8001 ) &
# open http://127.0.0.1:8000  (central serves frontend/dist)
```

Tailwind is compiled into `dist/assets/*.css`, so the UI renders with no internet
access — important for the offline-first pitch.

---

## 5. Configuration (environment variables)

### Checkpoint node
| Var | Default | Meaning |
|-----|---------|---------|
| `ZONE_ID` | `indore` | which zone this node guards |
| `CHECKPOINT_ID` | `cp-<ZONE_ID>` | node identity reported at sync |
| `CENTRAL_URL` | `http://127.0.0.1:8000` | where to sync |
| `NODE_TOKEN` | `node-<ZONE_ID>-secret` | per-node secret authenticating sync to central (matches the seed) |
| `ENFORCE_WINDOW` | `0` | `1` = deny tickets scanned outside their slot window |
| `WINDOW_GRACE_MIN` | `120` | grace minutes around the slot window |

> `ENFORCE_WINDOW` is **off by default** so the seeded 2028 demo data verifies
> when you run it today. Turn it on (`ENFORCE_WINDOW=1`) to demonstrate
> arrival-window enforcement. `NODE_TOKEN` defaults to the value central seeds, so
> the node syncs out-of-the-box; override both in production.

### Central
| Var | Default | Meaning |
|-----|---------|---------|
| `BOOKING_CAP_PER_PHONE` | `3` | max active bookings per citizen phone per event date (anti-tout) |
| `OVERBOOK_RATIO` | `1.15` | bookable ceiling = Σ(lot capacity) × this (physical-capacity guard, C4) |
| `TICKET_EXP_GRACE_HOURS` | `6` | hard ticket expiry past the slot end |

### Demo logins (seeded)
Password for all staff: **`simhastha28`**.
- **Command Centre:** `commander.a`, `commander.b` (both needed to *lift* a lockdown),
  `dispatcher` (may issue emergency passes), `op.<zone>` (operator).
- **Citizen:** verify any 10-digit mobile — the OTP is shown on screen (mock SMS).

### Frontend
- Central base URL is the relative `/api` (see `frontend/src/api.js`).
- Checkpoint base URL defaults to `http://127.0.0.1:8001`, editable in the UI and
  persisted to `localStorage` (`cp_base`).
- Auth tokens (staff/citizen) are stored in `localStorage` (`staff`, `citizen`).

---

## 6. Reset to a clean demo state

The SQLite databases live in `data/`. To wipe all bookings, lockdowns, and node
caches and start fresh:

```bash
# stop the stack first (Ctrl-C), then:
rm -f data/*.db
./scripts/run.sh        # schema + Ujjain seed data are recreated on startup
```

Cryptographic material in `keys/` is regenerated automatically if absent:
`central_ed25519.*` (ticket signing), `session_secret` (auth-token HMAC), and
`plate_secret` (plate-HMAC for the privacy-preserving plate binding).
Deleting the keypair invalidates any tickets already issued; deleting
`session_secret` invalidates all logged-in sessions (everyone re-authenticates).
The seed recreates demo staff accounts and parking lots on startup.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `address already in use` | A previous run is still up. `kill $(lsof -ti tcp:8000 -ti tcp:8001 -ti tcp:5173)` |
| **Gate Operator shows "not connected" / all buttons disabled** | The gate node (port 8001) isn't running — start it (see §3 "Run each service individually"). The console reconnects automatically. NB: "offline · link cut" is different — that's the gate running with its central uplink toggled off, and is normal. |
| Operator **Verify** buttons stay greyed | By design — they enable once you paste a QR token or type a 6-char code. Network/deny-all/sync live under the **Node** tab. |
| Frontend loads unstyled | Stale build from before Tailwind was compiled in. `cd frontend && npm run build` |
| Node `/verify` says "no public key provisioned" | Run one `POST :8001/sync` while online, or ensure `keys/central_ed25519.pub` exists |
| `/sync` returns 409 | Node network is OFF — flip it ON in the Checkpoint → Node tab |
| Booking returns 423 | The zone (or ALL) is under lockdown — lift it in the Command Centre |
| Booking returns 409 `slot full` | Capacity sold out (or a race lost — first to pay wins). Pick another slot. |
| Booking returns 401 | Not phone-verified — complete the mobile-OTP step first (citizen token required) |
| Booking returns 429 | Per-phone booking cap reached for that date — use a different number or date |
| Admin call returns 401/403 | Sign in as a commander; lifting a lockdown also needs a *second* commander |
| `/sync` returns 401 `invalid node token` | `NODE_TOKEN` doesn't match `checkpoints.token` — unset it to use the seeded default |
| "I don't see API calls in the address bar" | It's a single-page app — calls happen via `fetch`. Watch them in DevTools → Network → Fetch/XHR. See [FAQ.md](./FAQ.md). |
| `npm install` warns about esbuild scripts | Harmless; the build still works (verified) |

For conceptual questions (offline verification, sync, concurrency/holds), see
[FAQ.md](./FAQ.md).
