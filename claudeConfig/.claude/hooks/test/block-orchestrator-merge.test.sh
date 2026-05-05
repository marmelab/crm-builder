#!/bin/bash
# Tests for block-orchestrator-merge.sh
# Hook should block git merge / git pull / etc. from the orchestrator (agent_type=""),
# allow them from any subagent (agent_type non-empty).

set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/block-orchestrator-merge.sh"

PASS=0
FAIL=0

run_case() {
  local label="$1"
  local input="$2"
  local expected_exit="$3"

  local actual_exit
  echo "$input" | bash "$HOOK" >/dev/null 2>&1
  actual_exit=$?

  if [ "$actual_exit" = "$expected_exit" ]; then
    echo "PASS — $label (exit=$actual_exit)"
    PASS=$((PASS + 1))
  else
    echo "FAIL — $label (expected exit=$expected_exit, got $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

# --- Orchestrator (agent_type="") cases ---
run_case "orch git merge → blocked" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"cd /app && git merge --no-ff feature/x"}}' \
  2

run_case "orch git checkout main → blocked" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"git checkout main"}}' \
  2

run_case "orch git checkout master → blocked" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"git checkout master"}}' \
  2

run_case "orch git pull → blocked" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"git pull --ff-only"}}' \
  2

run_case "orch git worktree remove → blocked" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"git worktree remove /app/worktrees/TASK-001"}}' \
  2

run_case "orch apply-app-variant.sh → blocked" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"/entrypoint-helpers/apply-app-variant.sh"}}' \
  2

run_case "orch git status → allowed" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"git status"}}' \
  0

run_case "orch ls → allowed" \
  '{"tool_name":"Bash","agent_type":"","tool_input":{"command":"ls /app/worktrees/"}}' \
  0

# --- Subagent (agent_type non-empty) cases ---
run_case "merger git merge → allowed" \
  '{"tool_name":"Bash","agent_type":"merger","tool_input":{"command":"git merge --no-ff feature/x"}}' \
  0

run_case "developer git merge (SIMPLE flow doesnt do this anymore but hook allows) → allowed" \
  '{"tool_name":"Bash","agent_type":"developer","tool_input":{"command":"git merge --no-ff feature/x"}}' \
  0

run_case "merger apply-app-variant.sh → allowed" \
  '{"tool_name":"Bash","agent_type":"merger","tool_input":{"command":"/entrypoint-helpers/apply-app-variant.sh"}}' \
  0

# --- Non-Bash tool calls ---
run_case "orch SendMessage → allowed (not Bash)" \
  '{"tool_name":"SendMessage","agent_type":"","tool_input":{"to":"developer-TASK-001","message":"GO"}}' \
  0

run_case "orch Read → allowed" \
  '{"tool_name":"Read","agent_type":"","tool_input":{"file_path":"/app/something"}}' \
  0

# --- Edge cases ---
run_case "empty stdin → exit 0 (defensive)" \
  '' \
  0

run_case "malformed JSON → exit 0 (defensive)" \
  'not-json{' \
  0

echo ""
echo "============================="
echo "Total: $((PASS + FAIL))  PASS: $PASS  FAIL: $FAIL"

[ "$FAIL" = "0" ]
