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

# Test 3: validate when target is quality-reviewer with v3 suffixed name
# We can't easily mock real npm runs in a unit test, so we run with VALIDATE_DRY_RUN=1
# which the script must honor (skip actual command execution but log the would-be calls).
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=quality-reviewer-TASK-001 (v3 suffixed)" 0 $?

# Test 4: validate when target is test-validator (v3 suffixed)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"test-validator-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=test-validator-TASK-001 (v3 suffixed)" 0 $?

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

# Test 7: legacy @-suffix form still validated (back-compat safety)
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

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
exit $FAIL
