#!/bin/bash
# SubagentStop hook — prettier check after developer finishes.
# Exit 2 on failure → stderr injected, subagent stays alive to run prettier:apply.

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] prettier START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

cd "$CLAUDE_PROJECT_DIR" || { echo "[$(date -Iseconds)] prettier EXIT=0 cd_failed" >> "$LOG"; exit 0; }

OUTPUT=$(npm run prettier 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Prettier check failed — run 'npm run prettier:apply' to fix formatting:" >&2
  echo "$OUTPUT" | tail -20 >&2
  echo "[$(date -Iseconds)] prettier EXIT=2 npm_exit=$EXIT_CODE" >> "$LOG"
  exit 2
fi

echo "[$(date -Iseconds)] prettier EXIT=0 OK" >> "$LOG"
exit 0
