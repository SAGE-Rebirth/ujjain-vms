# Zone & Portal URLs — Ujjain VMS

Quick reference for every URL in the running prototype: the three frontend portals
(now deep-linkable via client-side routing) and the per-zone checkpoint node
endpoints. Host is `127.0.0.1` for the local demo.

---

## Frontend portals (`http://127.0.0.1:5173` in dev · `:8000` when central serves the build)

The portal + section live in the URL path, so these are deep-linkable and the
browser back/forward buttons work.

| URL | Portal / screen |
|-----|-----------------|
| `/` | Portal picker |
| `/citizen/home` | Citizen — live availability |
| `/citizen/book` | Citizen — booking wizard *(phone-OTP gated)* |
| `/citizen/passes` | Citizen — My Passes *(phone-OTP gated)* |
| `/operator/scan` | Gate Operator — scanner |
| `/operator/lots` | Gate Operator — parking occupancy |
| `/operator/reassign` | Gate Operator — reassign any parked vehicle |
| `/operator/activity` | Gate Operator — recent decisions |
| `/operator/node` | Gate Operator — node controls (network / deny-all / sync) |
| `/command/dash` | Command Centre — live operations + Sync all nodes *(commander login)* |
| `/command/capacity` | Command Centre — capacity planner |
| `/command/audit` | Command Centre — audit log |

> In dev, open `http://127.0.0.1:5173/operator/scan` directly and it loads there.
> When central serves the built frontend, the same paths resolve via its SPA fallback.

---

## Central command

| Service | URL |
|---------|-----|
| Central API | `http://127.0.0.1:8000` |
| API docs (Swagger) | `http://127.0.0.1:8000/docs` |
| Public key (for nodes) | `http://127.0.0.1:8000/api/public_key` |

---

## Checkpoint node URLs (one per zone)

Each zone runs its **own** checkpoint node process with its own SQLite cache, and
each node only holds **its own zone's** passes (a gate denies other zones' passes
by design). `scripts/run.sh` assigns ports sequentially from `:8001` **in the order
zones are listed in `CHECKPOINTS`** — the table below is the mapping when you launch
all seven in seed order (see the command underneath).

| Zone id | Zone name | Approach road | Node URL | Checkpoint id | Sync token (demo default) |
|---------|-----------|---------------|----------|---------------|---------------------------|
| `indore` | Zone 1 — Indore Road | Indore Road | `http://127.0.0.1:8001` | `cp-indore` | `node-indore-secret` |
| `dewas` | Zone 2 — Dewas Road | Dewas Road | `http://127.0.0.1:8002` | `cp-dewas` | `node-dewas-secret` |
| `unhel` | Zone 3 — Unhel Road | Unhel Road | `http://127.0.0.1:8003` | `cp-unhel` | `node-unhel-secret` |
| `badnagar` | Zone 4 — Badnagar Road | Badnagar Road | `http://127.0.0.1:8004` | `cp-badnagar` | `node-badnagar-secret` |
| `agar` | Zone 5 — Agar Road | Agar Road | `http://127.0.0.1:8005` | `cp-agar` | `node-agar-secret` |
| `maksi` | Zone 6 — Maksi Road | Maksi Road | `http://127.0.0.1:8006` | `cp-maksi` | `node-maksi-secret` |
| `ramghat` | Zone 7 — Ramghat Approach | Ramghat Marg | `http://127.0.0.1:8007` | `cp-ramghat` | `node-ramghat-secret` |

Per-node endpoints (replace the port for the zone you want):
`/status` · `/verify` · `/exit` · `/reassign` · `/parked` · `/lots` · `/network` ·
`/denyall` · `/log` · `/sync` — see [docs/API.md](./docs/API.md).

---

## Launch all seven zones

```bash
CHECKPOINTS="indore dewas unhel badnagar agar maksi ramghat" ./scripts/run.sh
```

This starts central (`:8000`), the seven nodes (`:8001`–`:8007` in the order above),
and the Vite frontend (`:5173`). The default `./scripts/run.sh` (no `CHECKPOINTS`)
starts only `indore` on `:8001`.

---

## Bringing gates up/down from the UI (no terminal needed)

You no longer have to launch each checkpoint from a terminal or hand-manage gate
URLs. In **Command Centre → Dashboard**, every zone row has a **GATE** switch:

- Flip **GATE ON** — central spawns that zone's checkpoint node on its fixed port
  (the mapping in the table above: `indore`→`:8001`, … `ramghat`→`:8007`).
- Flip **GATE OFF** — central stops the gate it started.
- The per-zone **🛰️ sync** button and **Sync all gates** then work against
  whatever gates are up. A gate started by `run.sh` instead of the UI still shows
  as running, but can only be stopped where it was launched (the UI reports this,
  it doesn't fake-kill it).

The deterministic port-per-zone means the table above is now always accurate
regardless of launch order. `scripts/run.sh` is still available for launching
everything at once from a terminal if you prefer.
