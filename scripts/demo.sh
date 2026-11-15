#!/bin/bash
# Serve What's Between from this Mac to the internet, with full functionality.
#
#   scripts/demo.sh            # once whatsbetween.us is on Cloudflare (named tunnel set up)
#   scripts/demo.sh --quick    # temporary https://<random>.trycloudflare.com address, no setup
#
# Starts the graph service (if not already running), builds and serves the app on port 3000,
# keeps the Mac awake, and opens a Cloudflare Tunnel. Ctrl-C stops everything it started.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_CONFIG="$HOME/.cloudflared/whatsbetween.yml"
LOGS="$ROOT/data/demo-logs"
mkdir -p "$LOGS"
pids=()

cleanup() {
  echo
  echo "Stopping demo processes..."
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

wait_for() { # url, label
  for _ in $(seq 1 90); do
    curl -fsS -o /dev/null "$1" 2>/dev/null && { echo "  $2 is up."; return 0; }
    sleep 1
  done
  echo "  $2 did not start. See $LOGS." >&2
  exit 1
}

echo "1/4 Graph service (port 8788)"
if curl -fsS -o /dev/null http://127.0.0.1:8788/health 2>/dev/null; then
  echo "  Already running."
else
  (cd "$ROOT" && exec env/bin/python -m sdow.graph_service \
    --db data/sdow-20231220/sdow.sqlite --port 8788) >"$LOGS/graph.log" 2>&1 &
  pids+=($!)
  wait_for http://127.0.0.1:8788/health "Graph service"
fi

echo "2/4 App (port 3000)"
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  Port 3000 is already in use. Stop that server first (it may be an old build), then rerun." >&2
  exit 1
fi
(cd "$ROOT/website" && exec npm run serve) >"$LOGS/app.log" 2>&1 &
pids+=($!)
wait_for http://127.0.0.1:3000/ "App"

echo "3/4 Keeping the Mac awake while the demo runs"
caffeinate -dimsu &
pids+=($!)

echo "4/4 Tunnel"
if [[ "${1:-}" == "--quick" ]]; then
  echo "  Temporary address (changes every run); look for the trycloudflare.com line below."
  exec cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000
elif [[ -f "$TUNNEL_CONFIG" ]]; then
  echo "  Serving https://whatsbetween.us"
  exec cloudflared tunnel --no-autoupdate --config "$TUNNEL_CONFIG" run
else
  echo "  No named tunnel yet ($TUNNEL_CONFIG). Use --quick, or finish the domain setup in PRIORITIES.md." >&2
  exit 1
fi
