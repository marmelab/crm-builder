#!/bin/bash
# SubagentStop hook — unit tests (functions).
# Exit 2 on failure → stderr injected, subagent stays alive.

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] unit-fn START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

cd "$CLAUDE_PROJECT_DIR" || { echo "[$(date -Iseconds)] unit-fn EXIT=0 cd_failed" >> "$LOG"; exit 0; }

OUTPUT=$(CI=true npm run test:unit:functions 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT" | tail -50 >&2
    echo "[$(date -Iseconds)] unit-fn EXIT=2 npm_exit=$EXIT_CODE" >> "$LOG"
    exit 2
fi

echo "[$(date -Iseconds)] unit-fn EXIT=0 OK" >> "$LOG"
exit 0
