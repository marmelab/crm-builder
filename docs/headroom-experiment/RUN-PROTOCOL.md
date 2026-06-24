# Benchmark run protocol — 4 arms × 3 repetitions

## Prerequisites

- `atomic-crm-dev:headroom` image built from `feat/headroom` (includes RTK).
- Headroom proxy running on host port 8787 for arms 2-3:
  ```bash
  docker run -d --name headroom-proxy -p 8787:8787 \
    ghcr.io/chopratejas/headroom:latest \
    --host 0.0.0.0 --port 8787 \
    --mode cache          # change to --mode token for arm 3
    --no-telemetry --no-subscription-tracking
  ```
- `make wipe` available and working (resets the CRM app volume).

## Per-arm instance setup

| ARM | Compose files | Extra env |
|---|---|---|
| `baseline` | `docker-compose.yml -f docker-compose.multi.yml` | — |
| `headroom-cache` | `... -f docker-compose.headroom.yml` | proxy `--mode cache` |
| `headroom-token` | `... -f docker-compose.headroom.yml` | proxy `--mode token` |
| `rtk` | `... -f docker-compose.rtk.yml` | `RTK_ENABLED=1` in override |

## Run loop (repeat for each ARM and REP 1..3)

```bash
# 1. Wipe the CRM state
make wipe

# 2. Start the instance (adjust PORT_CRM / PORT_CHAT / INSTANCE per arm)
INSTANCE=<arm> PORT_CRM=5177 PORT_CHAT=8087 IMAGE=atomic-crm-dev:headroom \
  docker compose -p <arm> \
    -f docker-compose.yml \
    -f docker-compose.multi.yml \
    [-f docker-compose.headroom.yml | -f docker-compose.rtk.yml] \
    up -d

# 3. Wait for the app to be ready
curl -sf http://127.0.0.1:8087/api/stats > /dev/null && echo ready

# 4. Run the replay driver (inside the container)
SESSION_ID=$(docker exec <container> \
  node /app/docs/headroom-experiment/ws-feature-replay.mjs \
  2>&1 | grep SESSION_ID | awk -F= '{print $2}')
echo "Session: $SESSION_ID"

# 5. Collect results
SESSION_ID=$SESSION_ID ARM=<arm> REP=<rep> PORT_CHAT=8087 \
  [CONTAINER=<container>]  \  # only for rtk arm
  bash docs/headroom-experiment/collect-results.sh
```

## After all 12 runs

Results are in `docs/headroom-experiment/results/`.
Run the analysis script (Task 7 — TBD after data collection):
```bash
node docs/headroom-experiment/analyze-results.mjs
```
