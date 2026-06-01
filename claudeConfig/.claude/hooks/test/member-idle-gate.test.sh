#!/bin/bash
# Tests the migration-review bypass for quality-reviewer.
set -u
HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/member-idle-gate.sh"
PASS=0; FAIL=0
export CHAT_SESSION_DIR="/tmp/logs/ab12cd34-xxxx"; mkdir -p "$CHAT_SESSION_DIR"
run() { # label expected_exit stdin
  echo "$3" | CLAUDE_AGENT_NAME="quality-reviewer" bash "$HOOK" >/dev/null 2>&1
  local e=$?
  if [ "$e" = "$2" ]; then echo "PASS — $1"; PASS=$((PASS+1)); else echo "FAIL — $1 (exp $2 got $e)"; FAIL=$((FAIL+1)); fi
}
# A quality-reviewer reading the migration worktree must be ALLOWED (exit 0):
run "migration-review on _simple worktree → allowed" 0 \
  '{"agent_type":"quality-reviewer","tool_input":{"command":"cat /app/worktrees/ab12cd34/simple/supabase/migrations/x.sql"}}'
# A plain quality-reviewer with no flag and no migration path stays BLOCKED (exit 2):
run "premature review, no flag, no migration path → blocked" 2 \
  '{"agent_type":"quality-reviewer","tool_input":{"command":"ls"}}'
echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" = "0" ]
