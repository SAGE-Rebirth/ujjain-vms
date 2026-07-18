#!/usr/bin/env bash
# Launch the whole Ujjain VMS prototype locally. Everything Python runs inside
# the project .venv; the frontend runs from project-local node_modules. Nothing
# is installed on the host system.
#
#   ./scripts/run.sh            # central + both checkpoints (indore, dewas) + frontend
#   CHECKPOINTS="indore"        ./scripts/run.sh   # override the node list
#
# Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENV="$ROOT/.venv/bin"
PIDS=()

cleanup() {
  echo ""
  echo "Stopping…"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ Central command  → http://127.0.0.1:8000"
( cd backend/central && "$VENV/python" -m uvicorn app:app --host 127.0.0.1 --port 8000 --log-level warning ) &
PIDS+=($!)

PORT=8001
for ZONE in ${CHECKPOINTS:-indore dewas}; do
  echo "▶ Checkpoint $ZONE   → http://127.0.0.1:$PORT"
  ( cd backend/checkpoint && ZONE_ID="$ZONE" CHECKPOINT_ID="cp-$ZONE" \
      CENTRAL_URL="http://127.0.0.1:8000" \
      "$VENV/python" -m uvicorn node:app --host 127.0.0.1 --port "$PORT" --log-level warning ) &
  PIDS+=($!)
  PORT=$((PORT + 1))
done

echo "▶ Frontend (Vite)  → http://127.0.0.1:5173"
( cd frontend && npm run dev -- --host 127.0.0.1 ) &
PIDS+=($!)

echo ""
echo "════════════════════════════════════════════════"
echo "  Open  http://127.0.0.1:5173  in your browser"
echo ""
echo "  Demo logins (password: simhastha28)"
echo "    Command Centre : commander.a  /  commander.b  (both needed to LIFT a lockdown)"
echo "    Citizen        : verify any 10-digit mobile — OTP is shown on screen"
echo "  Ctrl-C to stop everything"
echo "════════════════════════════════════════════════"
wait
