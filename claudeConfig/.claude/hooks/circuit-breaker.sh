#!/bin/bash
# PreToolUse hook — circuit breaker for stuck agents.
# Counts Bash calls PER CHAT SESSION and blocks when limit is exceeded.
# Input on stdin: { session_id, tool_name, tool_input, ... }

set -e

ITERATION_LIMIT=30

# Read session_id from hook input
INPUT=$(cat)
SESSION_ID=$(node -e "try{const i=JSON.parse(process.argv[1]);console.log(i.session_id||'default')}catch{console.log('default')}" "$INPUT" 2>/dev/null || echo default)

COUNTER_DIR="${CLAUDE_PROJECT_DIR:-/tmp}/.claude/tmp"
mkdir -p "$COUNTER_DIR" 2>/dev/null || COUNTER_DIR=/tmp
COUNTER_FILE="$COUNTER_DIR/bash-count-${SESSION_ID}"

# Auto-reset if counter file is older than 1 hour (stale session)
if [ -f "$COUNTER_FILE" ] && [ "$(find "$COUNTER_FILE" -mmin +60 2>/dev/null)" ]; then
  rm -f "$COUNTER_FILE"
fi

COUNT=0
[ -f "$COUNTER_FILE" ] && COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [ "$COUNT" -gt "$ITERATION_LIMIT" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"Circuit breaker: $COUNT Bash calls in this session. Stop, report where you are blocked.\"}"
fi

exit 0