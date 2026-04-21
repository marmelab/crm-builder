#!/bin/bash
# SubagentStop hook — runs typecheck after developer finishes.
# Exit 2 on failure → stderr injected as error, subagent stays alive to fix.

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] typecheck START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR MODE=$MODE stdin_len=${#STDIN}" >> "$LOG"

cd "$CLAUDE_PROJECT_DIR" || { echo "[$(date -Iseconds)] typecheck EXIT=0 cd_failed" >> "$LOG"; exit 0; }

OUTPUT=$(npm run typecheck 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Typecheck failed — fix TypeScript errors before completing:" >&2
  echo "$OUTPUT" | tail -30 >&2
  echo "[$(date -Iseconds)] typecheck EXIT=2 npm_exit=$EXIT_CODE" >> "$LOG"
  exit 2
fi

echo "[$(date -Iseconds)] typecheck EXIT=0 OK" >> "$LOG"
exit 0
