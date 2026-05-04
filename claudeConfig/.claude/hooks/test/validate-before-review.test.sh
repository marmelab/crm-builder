#!/bin/bash
# Tests for validate-before-review.sh
# Run with: bash claudeConfig/.claude/hooks/test/validate-before-review.test.sh

set -u
SCRIPT_UNDER_TEST="$(dirname "$0")/../validate-before-review.sh"
PASS=0
FAIL=0

assert_exit() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1))
    echo "PASS — $desc (exit=$actual)"
  else
    FAIL=$((FAIL+1))
    echo "FAIL — $desc (expected=$expected actual=$actual)"
  fi
}

# Test 1: skip when SendMessage target is the team-lead (not a reviewer/merger)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"team-lead","message":"stuck"}}'
echo "$INPUT" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip when to=team-lead" 0 $?

# Test 2: skip when SendMessage target is another developer (cross-pair — shouldn't happen but be defensive)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-002","message":"hi"}}'
echo "$INPUT" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip when to=developer-TASK-002" 0 $?

# Test 3: validate when target is quality-reviewer (reviewers ARE gated so
# they only ever see validated commits; SHA cache makes repeats cheap).
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=quality-reviewer-TASK-001" 0 $?

# Test 4: validate when target is test-validator
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"test-validator-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=test-validator-TASK-001" 0 $?

# Test 5: validate when target is merger (v3 suffixed — back-compat for v3.0 per-ticket merger)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"merger-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=merger-TASK-001 (v3.0 back-compat)" 0 $?

# Test 5b: validate when target is the shared singleton merger (v3.1 single-merger)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"merger","message":"ready: TASK-001, branch=feature/x"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=merger (v3.1 shared singleton)" 0 $?

# Test 6: failure case — VALIDATE_DRY_RUN=fail simulates a failing sub-script
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer-TASK-001","message":"ready"}}'
echo "$INPUT" | VALIDATE_DRY_RUN=fail "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "block when one validator fails" 2 $?

# Test 7: legacy @-suffix reviewer form still validated
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer@ticket-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=quality-reviewer@ticket-TASK-001 (legacy)" 0 $?

# Test 8: malformed input — empty stdin → skip (not a SendMessage we can parse)
echo "" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip on empty stdin" 0 $?

# Test 9: malformed input — JSON without tool_input.to → skip
INPUT='{"tool_name":"SendMessage","tool_input":{}}'
echo "$INPUT" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip when tool_input.to is missing" 0 $?

assert_stderr_contains() {
  local desc="$1"
  local needle="$2"
  local actual="$3"
  if echo "$actual" | grep -qF -- "$needle"; then
    PASS=$((PASS+1))
    echo "PASS — $desc"
  else
    FAIL=$((FAIL+1))
    echo "FAIL — $desc (looking for '$needle' in stderr)"
    echo "  stderr was: $actual"
  fi
}

# VALIDATE_WORKTREE extraction tests — the hook must narrow validation to
# the caller's single worktree, not all worktrees (cross-worktree poisoning).

# 10: TASK-XXX in suffixed reviewer name → worktree extracted
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer-TASK-001","message":"ready"}}'
ERR=$(echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" 2>&1 >/dev/null)
assert_stderr_contains "extract worktree from quality-reviewer-TASK-001" "VALIDATE_WORKTREE=/app/worktrees/TASK-001" "$ERR"

# 11: to=merger, TASK-XXX in message body
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"merger","message":"ready: TASK-001, branch=feature/x"}}'
ERR=$(echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" 2>&1 >/dev/null)
assert_stderr_contains "extract worktree from merger message body" "VALIDATE_WORKTREE=/app/worktrees/TASK-001" "$ERR"

# 12: legacy @-suffix form
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer@ticket-TASK-001","message":"ready"}}'
ERR=$(echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" 2>&1 >/dev/null)
assert_stderr_contains "extract worktree from legacy @ticket-TASK-001" "VALIDATE_WORKTREE=/app/worktrees/TASK-001" "$ERR"

# 13: no TASK-XXX anywhere → fallback to <all>
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"merger","message":"ready"}}'
ERR=$(echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" 2>&1 >/dev/null)
assert_stderr_contains "fallback to <all> when no TASK-XXX present" "VALIDATE_WORKTREE=<all>" "$ERR"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
exit $FAIL
