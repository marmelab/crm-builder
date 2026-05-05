#!/bin/bash
# Tests for teamdelete-cleanup.sh
# Run with: bash claudeConfig/.claude/hooks/test/teamdelete-cleanup.test.sh

set -u
SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/teamdelete-cleanup.sh"
PASS=0
FAIL=0

assert() {
  local desc="$1"
  local cond="$2"
  if [ "$cond" = "true" ]; then
    PASS=$((PASS+1))
    echo "PASS — $desc"
  else
    FAIL=$((FAIL+1))
    echo "FAIL — $desc"
  fi
}

# Setup a fake team dir under a tmp HOME, then return the path.
make_team_dir() {
  local home="$1" team="$2"
  mkdir -p "$home/.claude/teams/$team/inboxes"
  echo '{}' > "$home/.claude/teams/$team/config.json"
  echo '[]' > "$home/.claude/teams/$team/inboxes/team-lead.json"
  echo "$home/.claude/teams/$team"
}

# Run the hook with a given stdin payload under a given HOME.
run_hook() {
  local home="$1" payload="$2"
  echo "$payload" | HOME="$home" "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
}

# ----------------------------------------------------------------------------
# Test 1: success + team_name in tool_response → dir removed
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
target=$(make_team_dir "$TMP" "alpha")
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{},"tool_response":{"success":true,"team_name":"alpha","message":"Cleaned up directories"}}'
run_hook "$TMP" "$PAYLOAD"
[ ! -d "$target" ] && assert "success → team dir removed" true || assert "success → team dir removed" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 2: success + team_name only in tool_input → also works
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
target=$(make_team_dir "$TMP" "beta")
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{"team_name":"beta"},"tool_response":{"success":true,"message":"ok"}}'
run_hook "$TMP" "$PAYLOAD"
[ ! -d "$target" ] && assert "team_name from tool_input → dir removed" true || assert "team_name from tool_input → dir removed" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 3: failed TeamDelete → dir untouched
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
target=$(make_team_dir "$TMP" "gamma")
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{"team_name":"gamma"},"tool_response":{"success":false,"message":"Cannot cleanup team with 1 active member(s)"}}'
run_hook "$TMP" "$PAYLOAD"
[ -d "$target" ] && assert "failed TeamDelete → dir untouched" true || assert "failed TeamDelete → dir untouched" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 4: missing team_name → no-op (no error)
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/teams"
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{},"tool_response":{"success":true}}'
run_hook "$TMP" "$PAYLOAD"
RC=$?
[ "$RC" = "0" ] && assert "missing team_name → exit 0" true || assert "missing team_name → exit 0" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 5: path traversal in team_name → refused, parent dir untouched
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/teams/legit"
echo "marker" > "$TMP/.claude/teams/legit/sentinel.txt"
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{},"tool_response":{"success":true,"team_name":"../legit"}}'
run_hook "$TMP" "$PAYLOAD"
[ -f "$TMP/.claude/teams/legit/sentinel.txt" ] && assert "path traversal refused — sentinel preserved" true || assert "path traversal refused — sentinel preserved" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 6: slash in team_name → refused
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/teams/safe"
echo "marker" > "$TMP/.claude/teams/safe/file.txt"
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{},"tool_response":{"success":true,"team_name":"foo/bar"}}'
run_hook "$TMP" "$PAYLOAD"
[ -f "$TMP/.claude/teams/safe/file.txt" ] && assert "slash in team_name refused — sibling preserved" true || assert "slash in team_name refused — sibling preserved" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 7: empty stdin → exit 0
# ----------------------------------------------------------------------------
echo "" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
[ "$?" = "0" ] && assert "empty stdin → exit 0" true || assert "empty stdin → exit 0" false

# ----------------------------------------------------------------------------
# Test 8: malformed JSON → exit 0
# ----------------------------------------------------------------------------
echo "not json" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
[ "$?" = "0" ] && assert "malformed stdin → exit 0" true || assert "malformed stdin → exit 0" false

# ----------------------------------------------------------------------------
# Test 9: team dir doesn't exist (already cleaned) → no-op, exit 0
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/teams"
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{},"tool_response":{"success":true,"team_name":"ghost"}}'
run_hook "$TMP" "$PAYLOAD"
[ "$?" = "0" ] && assert "missing team dir → exit 0 (no-op)" true || assert "missing team dir → exit 0 (no-op)" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 10: hook does not write to stdout/stderr (silent on success)
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "quiet" >/dev/null
PAYLOAD='{"tool_name":"TeamDelete","tool_input":{},"tool_response":{"success":true,"team_name":"quiet"}}'
out=$(echo "$PAYLOAD" | HOME="$TMP" "$SCRIPT_UNDER_TEST" 2>&1)
[ -z "$out" ] && assert "hook is silent on stdout/stderr" true || assert "hook is silent on stdout/stderr (got: $out)" false
rm -rf "$TMP"

# ----------------------------------------------------------------------------
echo
echo "============================="
echo "Total: $((PASS+FAIL))  PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
