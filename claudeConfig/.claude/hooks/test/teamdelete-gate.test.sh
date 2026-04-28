#!/bin/bash
# Tests for teamdelete-gate.sh
# Run with: bash claudeConfig/.claude/hooks/test/teamdelete-gate.test.sh

set -u
SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/teamdelete-gate.sh"
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
    if [ -n "${4:-}" ]; then
      echo "  stderr: $4"
    fi
  fi
}

assert_stderr_contains() {
  local desc="$1"
  local needle="$2"
  local stderr="$3"
  if echo "$stderr" | grep -qF -- "$needle"; then
    PASS=$((PASS+1))
    echo "PASS — $desc"
  else
    FAIL=$((FAIL+1))
    echo "FAIL — $desc (missing: '$needle')"
    echo "  stderr was: $stderr"
  fi
}

# ----------------------------------------------------------------------------
# Helpers to fabricate a fake team dir under a tmp HOME.
# ----------------------------------------------------------------------------
make_team_dir() {
  local home="$1" team="$2" session="$3"
  shift 3
  mkdir -p "$home/.claude/teams/$team/inboxes"
  cat > "$home/.claude/teams/$team/config.json" <<EOF
{
  "name": "$team",
  "description": "fixture",
  "createdAt": 1777384817975,
  "leadAgentId": "team-lead@$team",
  "leadSessionId": "$session",
  "members": [
    { "agentId": "team-lead@$team", "name": "team-lead", "agentType": "team-lead", "model": "sonnet", "joinedAt": 1, "tmuxPaneId": "", "cwd": "/", "subscriptions": [] }$(for m in "$@"; do
      printf ',\n    { "agentId": "%s@%s", "name": "%s", "agentType": "general-purpose", "model": "haiku", "joinedAt": 1, "tmuxPaneId": "in-process", "cwd": "/", "subscriptions": [] }' "$m" "$team" "$m"
    done)
  ]
}
EOF
  echo "[]" > "$home/.claude/teams/$team/inboxes/team-lead.json"
  for m in "$@"; do
    echo "[]" > "$home/.claude/teams/$team/inboxes/$m.json"
  done
}

# Append a shutdown_approved message from $member into the lead inbox of $team
# at $home, with the given read flag.
push_shutdown_approved() {
  local home="$1" team="$2" member="$3" read_flag="$4"
  local inbox="$home/.claude/teams/$team/inboxes/team-lead.json"
  local payload="{\"type\":\"shutdown_approved\",\"requestId\":\"sd-1@$member\",\"from\":\"$member\"}"
  jq --arg from "$member" --arg text "$payload" --argjson read "$read_flag" \
    '. + [{"from": $from, "text": $text, "timestamp": "2026-04-28T14:00:00Z", "color": "blue", "read": $read}]' \
    "$inbox" > "$inbox.new" && mv "$inbox.new" "$inbox"
}

# Run the hook under a given HOME with a tool_input team_name.
run_hook() {
  local home="$1" team="$2"
  local stderr_file
  stderr_file=$(mktemp)
  local stdin_json="{\"tool_name\":\"TeamDelete\",\"tool_input\":{\"team_name\":\"$team\"},\"session_id\":\"sess-1\"}"
  echo "$stdin_json" | HOME="$home" "$SCRIPT_UNDER_TEST" >/dev/null 2>"$stderr_file"
  local rc=$?
  HOOK_STDERR=$(cat "$stderr_file")
  rm -f "$stderr_file"
  return $rc
}

# Run the hook with empty tool_input (TeamDelete({})), relies on session_id resolution.
run_hook_no_team_name() {
  local home="$1" session_id="$2"
  local stderr_file
  stderr_file=$(mktemp)
  local stdin_json="{\"tool_name\":\"TeamDelete\",\"tool_input\":{},\"session_id\":\"$session_id\"}"
  echo "$stdin_json" | HOME="$home" "$SCRIPT_UNDER_TEST" >/dev/null 2>"$stderr_file"
  local rc=$?
  HOOK_STDERR=$(cat "$stderr_file")
  rm -f "$stderr_file"
  return $rc
}

# ----------------------------------------------------------------------------
# Test 1: pass when there are no non-lead members.
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "lonely" "sess-1"
run_hook "$TMP" "lonely"; rc=$?
assert_exit "lone team (no members) → allow" 0 $rc "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 2: pass when all members have shutdown_approved with read:true.
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "alpha" "sess-1" "developer" "merger"
push_shutdown_approved "$TMP" "alpha" "developer" true
push_shutdown_approved "$TMP" "alpha" "merger" true
run_hook "$TMP" "alpha"; rc=$?
assert_exit "all members ack'd & lead read → allow" 0 $rc "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 3: block when a member has no shutdown_approved (Step 3a missing).
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "beta" "sess-1" "developer" "merger"
# Only developer ack'd
push_shutdown_approved "$TMP" "beta" "developer" true
run_hook "$TMP" "beta"; rc=$?
assert_exit "missing shutdown_approved for merger → block" 2 $rc "$HOOK_STDERR"
assert_stderr_contains "block message lists pending member" "merger" "$HOOK_STDERR"
assert_stderr_contains "block message references Step 3a" "Step 3a" "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 4: block when shutdown_approved exists but read:false (Step 3b missing).
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "gamma" "sess-1" "developer"
push_shutdown_approved "$TMP" "gamma" "developer" false
run_hook "$TMP" "gamma"; rc=$?
assert_exit "shutdown_approved present but read:false → block" 2 $rc "$HOOK_STDERR"
assert_stderr_contains "block message references Step 3b yield" "Step 3b" "$HOOK_STDERR"
assert_stderr_contains "block message mentions yielding the turn" "yield" "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 5: block on team A, ignore unrelated team B's state.
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "ticket-TASK-001" "sess-1" "developer"
make_team_dir "$TMP" "ticket-TASK-002" "sess-1" "developer"
# Only TASK-001's developer is fully cleared
push_shutdown_approved "$TMP" "ticket-TASK-001" "developer" true
# TASK-002 has nothing → if we delete TASK-001, that's fine
run_hook "$TMP" "ticket-TASK-001"; rc=$?
assert_exit "delete cleared team while other team is dirty → allow" 0 $rc "$HOOK_STDERR"
# Now delete TASK-002 → must block, regardless of TASK-001's state
run_hook "$TMP" "ticket-TASK-002"; rc=$?
assert_exit "delete dirty team → block" 2 $rc "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 6: TeamDelete({}) with single session-owned team → resolve via session_id.
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "solo" "sess-1" "developer"
push_shutdown_approved "$TMP" "solo" "developer" true
run_hook_no_team_name "$TMP" "sess-1"; rc=$?
assert_exit "TeamDelete({}) resolves via session_id, allow when clean" 0 $rc "$HOOK_STDERR"
# Mark unread → should block
TMP2=$(mktemp -d)
make_team_dir "$TMP2" "solo2" "sess-1" "developer"
push_shutdown_approved "$TMP2" "solo2" "developer" false
run_hook_no_team_name "$TMP2" "sess-1"; rc=$?
assert_exit "TeamDelete({}) resolves via session_id, block when dirty" 2 $rc "$HOOK_STDERR"
rm -rf "$TMP" "$TMP2"

# ----------------------------------------------------------------------------
# Test 7: TeamDelete({}) with 2+ teams owned by session → no-op (let runtime error).
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
make_team_dir "$TMP" "ambig-A" "sess-1"
make_team_dir "$TMP" "ambig-B" "sess-1"
run_hook_no_team_name "$TMP" "sess-1"; rc=$?
assert_exit "TeamDelete({}) ambiguous → exit 0 (defer to runtime)" 0 $rc "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 8: team_name does not exist on disk → no-op (let runtime error).
# ----------------------------------------------------------------------------
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/teams"
run_hook "$TMP" "nonexistent"; rc=$?
assert_exit "missing team dir → exit 0" 0 $rc "$HOOK_STDERR"
rm -rf "$TMP"

# ----------------------------------------------------------------------------
# Test 9: empty stdin → exit 0 (defensive)
# ----------------------------------------------------------------------------
echo "" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "empty stdin → exit 0" 0 $?

# ----------------------------------------------------------------------------
# Test 10: malformed JSON tool_input → exit 0 (cannot parse, defer)
# ----------------------------------------------------------------------------
echo "not json" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "malformed stdin → exit 0" 0 $?

# ----------------------------------------------------------------------------
echo
echo "============================="
echo "Total: $((PASS+FAIL))  PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
