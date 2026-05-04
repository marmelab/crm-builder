#!/bin/bash
# SubagentStop hook — e2e tests.
# Exit 2 on failure → stderr injected, subagent stays alive.

LOG="$CHAT_SESSION_DIR/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] e2e START pwd=$(pwd) MODE=$MODE CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

cd "$CLAUDE_PROJECT_DIR" || { echo "[$(date -Iseconds)] e2e EXIT=0 cd_failed" >> "$LOG"; exit 0; }

if [ "${MODE:-demo}" = "demo" ]; then
  echo "[$(date -Iseconds)] e2e EXIT=0 skipped_demo" >> "$LOG"
  exit 0
fi

OUTPUT=$(npx playwright test 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT" | tail -50 >&2
    echo "[$(date -Iseconds)] e2e EXIT=2 playwright_exit=$EXIT_CODE" >> "$LOG"
    exit 2
fi

echo "[$(date -Iseconds)] e2e EXIT=0 OK" >> "$LOG"
exit 0
