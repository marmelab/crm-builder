# Headroom + RTK Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 4-arm benchmark harness (baseline / Headroom cache / Headroom token / RTK) for the context-compression study on AtomicCRM.

**Architecture:** Three self-contained changes — (1) a new replay driver that sends one feature message and stops on `satisfaction_ask`, (2) RTK installed in the Dockerfile and opt-in via `RTK_ENABLED=1` in `pty-session.js`, (3) a results collection script. No changes to production paths; everything is branch-local and env-gated.

**Tech Stack:** Node.js (ws-replay-driver), Rust binary (RTK via curl install), Docker Compose overrides, bash (results script).

## Global Constraints

- Branch: `feat/headroom` — never touch `main` files that don't exist on this branch.
- RTK activation is **only via `RTK_ENABLED=1`** env var — arm 4 only, never the default path.
- Headroom proxy mode (cache vs token) is set at **proxy startup** (`--mode` flag), not in the app code.
- Replay driver must stop as soon as `satisfaction_ask` arrives — do not send a reply.
- All result JSON files go to `docs/headroom-experiment/results/<arm>-<rep>.json`.
- Working directory for all bash commands: `/home/jerome/Work/crm-builder-root/feat-headroom`.

---

### Task 1: Feature replay driver

**Files:**
- Create: `docs/headroom-experiment/feature-messages.json`
- Create: `docs/headroom-experiment/ws-feature-replay.mjs`

**Interfaces:**
- Produces: CLI tool `node ws-feature-replay.mjs` that exits 0 on `satisfaction_ask`, prints `SESSION_ID=<uuid>` to stdout.

- [ ] **Step 1: Create the feature message JSON**

```bash
cat > docs/headroom-experiment/feature-messages.json << 'EOF'
[
  {
    "content": "I need to track equipment rentals. Add a rental entity linked to contacts, with a start date, end date, and status (pending/active/returned).",
    "display": "I need to track equipment rentals. Add a rental entity linked to contacts, with a start date, end date, and status (pending/active/returned)."
  }
]
EOF
```

- [ ] **Step 2: Create `ws-feature-replay.mjs`**

This is a simplified fork of `ws-replay-driver.mjs`. Key change: stop on `satisfaction_ask` event instead of after all messages are sent.

```js
// ws-feature-replay.mjs
// Replay a single feature-request message and stop when the satisfaction ask
// appears (before migration). Prints SESSION_ID=<uuid> to stdout.
//
//   node ws-feature-replay.mjs [messages.json]
//
// Env: WS_URL (default ws://127.0.0.1:8080), TURN_TIMEOUT_MS (default 2700000)

import { readFileSync } from 'node:fs';

const msgFile = process.argv[2] || new URL('./feature-messages.json', import.meta.url).pathname;
const MSGS = JSON.parse(readFileSync(msgFile, 'utf8'));
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8080';
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 2_700_000);

let idx = 0;
let sessionId = null;
let workingSeen = false;
let sent = false;
let turnTimer = null;
let done = false;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ws = new WebSocket(WS_URL);

function armTurnTimer() {
  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    log(`!! TURN TIMEOUT after ${TURN_TIMEOUT_MS}ms — aborting`);
    finish(2);
  }, TURN_TIMEOUT_MS);
}

function sendNext() {
  if (idx >= MSGS.length) {
    log('all messages sent — waiting for satisfaction_ask');
    return;
  }
  const m = MSGS[idx];
  idx++;
  sent = true;
  workingSeen = false;
  const payload = { content: m.content, display: m.display || m.content };
  log(`>> send #${idx}/${MSGS.length}: ${JSON.stringify(m.content).slice(0, 120)}`);
  ws.send(JSON.stringify(payload));
  armTurnTimer();
}

function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(turnTimer);
  log(`SESSION_ID=${sessionId}`);
  log(`DONE exit=${code}`);
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 500);
}

ws.addEventListener('open', () => log('ws open'));
ws.addEventListener('error', (e) => { log('ws error', e.message || e); finish(3); });
ws.addEventListener('close', () => { if (!done) log('ws closed by server'); });

ws.addEventListener('message', (ev) => {
  let o;
  try { o = JSON.parse(ev.data); } catch { return; }

  switch (o.type) {
    case 'init':
      sessionId = o.sessionId;
      log(`init sessionId=${sessionId}`);
      setTimeout(sendNext, 250);
      break;

    case 'status':
      if (o.working === true) { workingSeen = true; }
      else if (o.working === false && sent && workingSeen) {
        if (idx >= MSGS.length) {
          // All messages sent and turn finished — keep waiting for satisfaction_ask
          log('turn complete — waiting for satisfaction_ask');
          armTurnTimer();
        } else {
          setTimeout(sendNext, 400);
        }
      }
      break;

    case 'satisfaction_ask':
      log(`<< satisfaction_ask received: "${o.header}" — stopping (no reply)`);
      finish(0);
      break;

    case 'state':
      log(`<< state=${o.state}`);
      if (o.state === 'error') { log('ERROR state — aborting'); finish(4); }
      if (o.state === 'rate_limited') { log('RATE LIMITED — aborting'); finish(5); }
      break;

    case 'message':
      if (o.role === 'assistant' && o.content) {
        log(`<< assistant: ${o.content.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      break;

    case 'stats':
      log(`-- tokens=${o.tokensTotal} cost=$${(o.costUsd ?? 0).toFixed?.(2)} agents=${o.activeAgents}`);
      break;
  }
});
```

- [ ] **Step 3: Smoke-test the driver structure**

```bash
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const msgs = JSON.parse(readFileSync('docs/headroom-experiment/feature-messages.json', 'utf8'));
console.assert(msgs.length === 1, 'should have 1 message');
console.assert(msgs[0].content.includes('rental'), 'should contain rental');
console.log('OK: feature-messages.json valid');
EOF
```

Expected: `OK: feature-messages.json valid`

- [ ] **Step 4: Commit**

```bash
git add docs/headroom-experiment/feature-messages.json docs/headroom-experiment/ws-feature-replay.mjs
git commit -m "feat(bench): feature replay driver — stops on satisfaction_ask"
```

---

### Task 2: RTK in Dockerfile

**Files:**
- Modify: `Dockerfile` — install RTK binary in runtime image

**Interfaces:**
- Produces: `rtk` binary available at `/usr/local/bin/rtk` inside the container (only callable when `RTK_ENABLED=1`).

- [ ] **Step 1: Find the right install location in the Dockerfile**

```bash
grep -n "npm install -g\|RUN curl\|wrangler\|playwright" Dockerfile | head -10
```

The RTK install should go after the other global tools (after the `npm install -g wrangler` line, before the `COPY` of app source).

- [ ] **Step 2: Add RTK install to Dockerfile**

Find this block in `Dockerfile`:
```dockerfile
RUN npm install -g wrangler@${WRANGLER_VERSION}
```

Add after it:
```dockerfile
# RTK — context-compression CLI (feat/headroom benchmark, arm 4 only).
# Activated at runtime via RTK_ENABLED=1 in pty-session.js.
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh | sh \
    || true
```

The `|| true` prevents a build failure if the install script is temporarily unavailable — we'll verify the binary in the next step.

- [ ] **Step 3: Verify RTK installs (build test)**

```bash
# Build the image locally to confirm RTK installs without error
docker build --build-arg CACHEBUST=$(date +%s) -t atomic-crm-dev:headroom . 2>&1 | tail -20
```

Expected: build completes, no error on the RTK install layer.

Then verify binary:
```bash
docker run --rm atomic-crm-dev:headroom rtk --version
```

Expected: prints a version string like `rtk 0.x.x`.

- [ ] **Step 4: Run `rtk init` non-interactively inside the container**

RTK requires `rtk init` to configure the Claude Code integration. Check if it can run non-interactively:

```bash
docker run --rm atomic-crm-dev:headroom rtk init --help 2>&1 | head -20
```

If `rtk init` has a `--yes` or `--non-interactive` flag, add it to the Dockerfile after the install:

```dockerfile
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh | sh \
    && rtk init --yes \
    || true
```

If it doesn't support non-interactive mode, skip `rtk init` in the Dockerfile and document that it must be run manually the first time the container starts (once, before arm-4 runs).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat(bench): install RTK binary in Dockerfile (arm 4 opt-in)"
```

---

### Task 3: RTK opt-in in pty-session.js

**Files:**
- Modify: `chat-service/lib/server/pty-session.js` line ~69

**Interfaces:**
- Consumes: `process.env.RTK_ENABLED` — if `'1'`, spawn `rtk` with `claude` as first arg.
- Produces: all `claude` subagents transparently wrapped by RTK when `RTK_ENABLED=1`.

- [ ] **Step 1: Read the spawn line**

```bash
sed -n '65,75p' chat-service/lib/server/pty-session.js
```

Confirm it reads: `this.#pty = pty.spawn('claude', args, {`

- [ ] **Step 2: Apply the one-line change**

In `chat-service/lib/server/pty-session.js`, replace:

```js
    this.#pty = pty.spawn('claude', args, {
```

with:

```js
    const spawnCmd = process.env.RTK_ENABLED === '1' ? 'rtk' : 'claude';
    const spawnArgs = process.env.RTK_ENABLED === '1' ? ['claude', ...args] : args;
    this.#pty = pty.spawn(spawnCmd, spawnArgs, {
```

- [ ] **Step 3: Verify no change when RTK_ENABLED is unset**

```bash
node --input-type=module << 'EOF'
// Simulate: RTK_ENABLED unset
const env = {};
const spawnCmd = env.RTK_ENABLED === '1' ? 'rtk' : 'claude';
const args = ['--print', 'hi'];
const spawnArgs = env.RTK_ENABLED === '1' ? ['claude', ...args] : args;
console.assert(spawnCmd === 'claude', 'should be claude when unset');
console.assert(spawnArgs[0] === '--print', 'args unchanged');
console.log('OK: baseline spawn unchanged');
EOF
```

Expected: `OK: baseline spawn unchanged`

- [ ] **Step 4: Verify RTK path when RTK_ENABLED=1**

```bash
node --input-type=module << 'EOF'
const env = { RTK_ENABLED: '1' };
const spawnCmd = env.RTK_ENABLED === '1' ? 'rtk' : 'claude';
const args = ['--print', 'hi'];
const spawnArgs = env.RTK_ENABLED === '1' ? ['claude', ...args] : args;
console.assert(spawnCmd === 'rtk', 'should be rtk');
console.assert(spawnArgs[0] === 'claude', 'first arg should be claude');
console.assert(spawnArgs[1] === '--print', 'original args follow');
console.log('OK: RTK spawn correct');
EOF
```

Expected: `OK: RTK spawn correct`

- [ ] **Step 5: Commit**

```bash
git add chat-service/lib/server/pty-session.js
git commit -m "feat(bench): opt-in RTK spawn via RTK_ENABLED=1 (arm 4 only)"
```

---

### Task 4: Compose override for RTK arm

**Files:**
- Create: `docker-compose.rtk.yml`

**Interfaces:**
- Produces: compose override that sets `RTK_ENABLED=1` on `crm-app`, analogous to `docker-compose.headroom.yml`.

- [ ] **Step 1: Create `docker-compose.rtk.yml`**

```yaml
# RTK benchmark override (feat/headroom, arm 4).
# Activates the RTK wrapper in pty-session.js via RTK_ENABLED=1.
# No proxy — RTK is a local CLI wrapper installed in the image.
#
# Usage:
#   INSTANCE=rtk PORT_CRM=5179 PORT_CHAT=8089 \
#     IMAGE=atomic-crm-dev:headroom \
#     docker compose -p rtk \
#       -f docker-compose.yml \
#       -f docker-compose.multi.yml \
#       -f docker-compose.rtk.yml up -d

services:
  crm-app:
    environment:
      - RTK_ENABLED=1
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.rtk.yml
git commit -m "feat(bench): docker-compose.rtk.yml override for arm 4"
```

---

### Task 5: Results collection script

**Files:**
- Create: `docs/headroom-experiment/collect-results.sh`
- Create: `docs/headroom-experiment/results/.gitkeep`

**Interfaces:**
- Consumes: `SESSION_ID` env var, `ARM` env var, `REP` env var, `PORT_CHAT` env var (default 8080), `CONTAINER` env var (for `rtk gain`, arm 4 only).
- Produces: `docs/headroom-experiment/results/<ARM>-<REP>.json` with stats + metadata.

- [ ] **Step 1: Create the results directory**

```bash
mkdir -p docs/headroom-experiment/results
touch docs/headroom-experiment/results/.gitkeep
```

- [ ] **Step 2: Create `collect-results.sh`**

```bash
cat > docs/headroom-experiment/collect-results.sh << 'SCRIPT'
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

python3 - << PYEOF
import json, sys
stats = json.loads('''$STATS''')
rtk_gain = $RTK_GAIN
out = {
    "arm": "$ARM",
    "rep": $REP,
    "session_id": "$SESSION_ID",
    "stats": stats,
    "rtk_gain": rtk_gain,
}
with open("$OUT", "w") as f:
    json.dump(out, f, indent=2)
print(f"[collect] saved {len(json.dumps(out))} bytes to $OUT")
PYEOF
SCRIPT
chmod +x docs/headroom-experiment/collect-results.sh
```

- [ ] **Step 3: Smoke-test the script help**

```bash
bash docs/headroom-experiment/collect-results.sh 2>&1 | head -5
```

Expected: prints `SESSION_ID required` error (correct — no env set).

- [ ] **Step 4: Commit**

```bash
git add docs/headroom-experiment/collect-results.sh docs/headroom-experiment/results/.gitkeep
git commit -m "feat(bench): results collection script + results/ directory"
```

---

### Task 6: Run protocol documentation

**Files:**
- Create: `docs/headroom-experiment/RUN-PROTOCOL.md`

**Interfaces:**
- Produces: step-by-step operator guide for the 12 runs (4 arms × 3 reps).

- [ ] **Step 1: Create `RUN-PROTOCOL.md`**

```bash
cat > docs/headroom-experiment/RUN-PROTOCOL.md << 'EOF'
# Benchmark run protocol — 4 arms × 3 repetitions

## Prerequisites

- `atomic-crm-dev:headroom` image built from `feat/headroom` (includes RTK).
- Headroom proxy running on host port 8787 for arms 2-3:
  ```bash
  docker run -d --name headroom-proxy -p 8787:8787 \
    ghcr.io/chopratejas/headroom:latest \
    --host 0.0.0.0 --port 8787 \
    --mode cache \          # change to --mode token for arm 3
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
EOF
```

- [ ] **Step 2: Commit**

```bash
git add docs/headroom-experiment/RUN-PROTOCOL.md
git commit -m "docs(bench): run protocol for 4-arm × 3-rep benchmark"
```

---

## Self-review

**Spec coverage:**
- ✅ 4 arms (baseline / headroom-cache / headroom-token / RTK)
- ✅ Single feature message, stops on satisfaction_ask
- ✅ RTK opt-in via `RTK_ENABLED=1` only
- ✅ `make wipe` between runs (documented in protocol)
- ✅ Results collected to `results/<arm>-<rep>.json`
- ✅ Full token breakdown (input / cacheCreate / cacheRead / output) via `/api/stats`
- ✅ RTK gain captured via `rtk gain --json`
- ⚠️ **Analysis script not in scope here** — run protocol references it as "TBD after data collection". The analysis script (aggregate, normalize by ticket, causal breakdown) should be a separate task once data exists.
- ⚠️ **RTK `rtk init` behavior** — Task 2 Step 4 documents the ambiguity and provides a fallback. Needs manual verification on first build.

**No placeholders:** all steps have concrete code or commands.

**Type consistency:** `SESSION_ID` string used consistently across replay driver stdout and collect-results.sh.
