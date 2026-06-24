#!/usr/bin/env bash
# collect-results.sh — snapshot /api/stats (+ rtk gain for arm 4) after each run.
#
# Required env: SESSION_ID, ARM (baseline|headroom-cache|headroom-token|rtk), REP (1|2|3)
# Optional env: PORT_CHAT (default 8080), CONTAINER (docker container name, for rtk gain)
#
# Usage (from repo root):
#   SESSION_ID=abc123 ARM=baseline REP=1 bash docs/headroom-experiment/collect-results.sh

set -euo pipefail

: "${SESSION_ID:?SESSION_ID required}"
: "${ARM:?ARM required (baseline|headroom-cache|headroom-token|rtk)}"
: "${REP:?REP required (1|2|3)}"
PORT_CHAT="${PORT_CHAT:-8080}"
OUT="docs/headroom-experiment/results/${ARM}-${REP}.json"

echo "[collect] ARM=$ARM REP=$REP SESSION_ID=$SESSION_ID"

# Fetch /api/stats
STATS=$(curl -sf "http://127.0.0.1:${PORT_CHAT}/api/stats?sessionId=${SESSION_ID}")
if [ -z "$STATS" ]; then
  echo "[collect] ERROR: empty stats response" >&2
  exit 1
fi

# Build output JSON
RTK_GAIN="null"
if [ "$ARM" = "rtk" ] && [ -n "${CONTAINER:-}" ]; then
  RTK_RAW=$(docker exec "$CONTAINER" rtk gain --json 2>/dev/null || echo "null")
  if [ "$RTK_RAW" != "null" ]; then
    RTK_GAIN="$RTK_RAW"
  fi
fi

echo "$STATS" | python3 -c "
import json, sys
stats = json.load(sys.stdin)
rtk_gain = $RTK_GAIN
out = {
    'arm': '$ARM',
    'rep': $REP,
    'session_id': '$SESSION_ID',
    'stats': stats,
    'rtk_gain': rtk_gain,
}
with open('$OUT', 'w') as f:
    json.dump(out, f, indent=2)
print(f'[collect] saved {len(json.dumps(out))} bytes to $OUT')
"
