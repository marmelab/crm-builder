#!/bin/bash
# Tests for restrict-documentator-write.sh
# Hook is gated on DOCUMENTATOR_RUN=1. When active, it allows writes to:
#   - /app/docs/learnings/patterns.md (the ledger)
#   - /home/developer/.claude/settings.local.json
#   - /home/developer/.claude/local/** (runtime additions)
# Everything else is blocked. When inactive (no env var), pass-through.

set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/restrict-documentator-write.sh"

PASS=0
FAIL=0

run_case() {
  local label="$1"
  local env_flag="$2"  # "1" for documentator run, "" for normal
  local input="$3"
  local expected_exit="$4"

  local actual_exit
  if [ -n "$env_flag" ]; then
    echo "$input" | DOCUMENTATOR_RUN="$env_flag" bash "$HOOK" >/dev/null 2>&1
  else
    echo "$input" | env -u DOCUMENTATOR_RUN bash "$HOOK" >/dev/null 2>&1
  fi
  actual_exit=$?

  if [ "$actual_exit" = "$expected_exit" ]; then
    echo "PASS — $label (exit=$actual_exit)"
    PASS=$((PASS + 1))
  else
    echo "FAIL — $label (expected exit=$expected_exit, got $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

# --- Inactive (no DOCUMENTATOR_RUN env var) — pass-through always ---
run_case "non-documentator session, any path → allowed" \
  "" \
  '{"tool_name":"Edit","tool_input":{"file_path":"/app/src/App.tsx"}}' \
  0

run_case "non-documentator session, base agent path → allowed" \
  "" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/agents/anything.md"}}' \
  0

# --- Active (DOCUMENTATOR_RUN=1) — strict allowlist ---
run_case "ledger write → allowed" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/app/docs/learnings/patterns.md"}}' \
  0

run_case "settings.local.json write → allowed" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/settings.local.json"}}' \
  0

run_case "local/agents file → allowed" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/local/agents/my-agent.md"}}' \
  0

run_case "local/skills file → allowed" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/local/skills/my-skill/SKILL.md"}}' \
  0

run_case "local/hooks file → allowed" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/local/hooks/my-hook.sh"}}' \
  0

run_case "local/rules file → allowed" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/local/rules/my-rule.md"}}' \
  0

run_case "base agents/ write → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/agents/foo.md"}}' \
  2

run_case "base settings.json write → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/settings.json"}}' \
  2

run_case "base hooks/ write → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/home/developer/.claude/hooks/foo.sh"}}' \
  2

run_case "app source code → blocked" \
  "1" \
  '{"tool_name":"Edit","tool_input":{"file_path":"/app/src/App.tsx"}}' \
  2

run_case "worktree code → blocked" \
  "1" \
  '{"tool_name":"Edit","tool_input":{"file_path":"/app/worktrees/TASK-001/src/foo.ts"}}' \
  2

run_case "empty file_path → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":""}}' \
  2

run_case "missing file_path → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{}}' \
  2

run_case "malformed JSON → blocked" \
  "1" \
  'not-json{' \
  2

# --- Edge cases: path lookalikes ---
run_case "path that contains 'local/' but not under base local/ → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/app/some/local/file.md"}}' \
  2

run_case "ledger lookalike (subpath) → blocked" \
  "1" \
  '{"tool_name":"Write","tool_input":{"file_path":"/app/docs/learnings/patterns.md.bak"}}' \
  2

echo ""
echo "============================="
echo "Total: $((PASS + FAIL))  PASS: $PASS  FAIL: $FAIL"

[ "$FAIL" = "0" ]
