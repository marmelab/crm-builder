#!/bin/bash
# TeammateIdle hook — log token usage when an agent goes idle

input=$(cat)

AGENT_NAME=$(echo "$input" | node -e "
const i = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(i.teammate_name || 'unknown')
" 2>/dev/null <<< "$input")

TRANSCRIPT=$(echo "$input" | node -e "
const i = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(i.transcript_path || '')
" 2>/dev/null <<< "$input")

TASK_SUBJECT=$(echo "$input" | node -e "
const i = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log(i.task_subject || '')
" 2>/dev/null <<< "$input")

# Count messages in transcript as proxy for token usage
MESSAGE_COUNT=0
if [ -f "$TRANSCRIPT" ]; then
  MESSAGE_COUNT=$(wc -l < "$TRANSCRIPT")
fi

LOG_FILE="$CLAUDE_PROJECT_DIR/docs/agent-stats.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "$(date +%Y-%m-%dT%H:%M:%S) | agent=$AGENT_NAME | task=$TASK_SUBJECT | transcript_lines=$MESSAGE_COUNT" >> "$LOG_FILE"

exit 0