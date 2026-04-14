#!/bin/bash
# PreToolUse hook — circuit breaker for stuck agents.
# Blocks further tool use if the agent has exceeded the iteration limit.

ITERATION_LIMIT=3
COUNTER_FILE="/tmp/agent-iterations-${TASK_ID:-default}"

# Read current iteration count
COUNT=0
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE")
fi

COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

if [ "$COUNT" -gt "$ITERATION_LIMIT" ]; then
  echo '{"decision":"block","reason":"Circuit breaker triggered: agent has exceeded 3 iterations without completing. Stop, summarize where you are blocked, and send the summary to the team-lead."}'
  exit 0
fi

exit 0