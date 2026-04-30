#!/bin/bash
# Tests for block-premature-shutdowns.sh
# Hook should block SendMessage(shutdown_request) when no merger report yet,
# allow once at least one "merged TASK-..." or "merge failed" arrived.

set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/block-premature-shutdowns.sh"

# Use a temp HOME so we don't touch the real ~/.claude/teams.
TEST_HOME=$(mktemp -d)
TEAM_DIR="$TEST_HOME/.claude/teams/tickets/inboxes"
mkdir -p "$TEAM_DIR"
INBOX="$TEAM_DIR/team-lead.json"

cleanup() { rm -rf "$TEST_HOME"; }
trap cleanup EXIT

PASS=0
FAIL=0

run_case() {
  local label="$1"
  local input="$2"
  local expected_exit="$3"

  local actual_exit
  echo "$input" | HOME="$TEST_HOME" bash "$HOOK" >/dev/null 2>&1
  actual_exit=$?

  if [ "$actual_exit" = "$expected_exit" ]; then
    echo "PASS — $label (exit=$actual_exit)"
    PASS=$((PASS + 1))
  else
    echo "FAIL — $label (expected exit=$expected_exit, got $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

# --- Case 1: no inbox file at all → block ---
rm -f "$INBOX"
run_case "no inbox file + shutdown_request → blocked" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":{"type":"shutdown_request"}}}' \
  2

# --- Case 2: empty inbox (no merger report yet) → block ---
echo '[]' > "$INBOX"
run_case "empty inbox + shutdown to dev → blocked" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":{"type":"shutdown_request"}}}' \
  2

run_case "empty inbox + shutdown to reviewer → blocked" \
  '{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer-TASK-001","message":{"type":"shutdown_request"}}}' \
  2

run_case "empty inbox + shutdown to merger → blocked" \
  '{"tool_name":"SendMessage","tool_input":{"to":"merger","message":{"type":"shutdown_request"}}}' \
  2

# Shutdown sent as a string message (not object)
run_case "empty inbox + shutdown as string message → blocked" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":"shutdown_request"}}' \
  2

# --- Case 3: inbox has merger reports → allow ---
cat > "$INBOX" <<'EOF'
[
  {"from":"merger","text":"merged TASK-001, commit=abc123"}
]
EOF
run_case "inbox has 1 merged report + shutdown → allowed" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":{"type":"shutdown_request"}}}' \
  0

cat > "$INBOX" <<'EOF'
[
  {"from":"merger","text":"TASK-002 merge failed: conflict in foo.ts"}
]
EOF
run_case "inbox has 1 merge-failed + shutdown → allowed" \
  '{"tool_name":"SendMessage","tool_input":{"to":"merger","message":{"type":"shutdown_request"}}}' \
  0

# Multiple reports
cat > "$INBOX" <<'EOF'
[
  {"from":"merger","text":"merged TASK-001, commit=abc"},
  {"from":"merger","text":"merged TASK-002, commit=def"}
]
EOF
run_case "inbox has multiple merged reports + shutdown → allowed" \
  '{"tool_name":"SendMessage","tool_input":{"to":"test-validator-TASK-001","message":{"type":"shutdown_request"}}}' \
  0

# --- Case 4: inbox has only non-merger messages → still block ---
cat > "$INBOX" <<'EOF'
[
  {"from":"developer-TASK-001","text":"TASK-001 stuck on quality-reviewer-TASK-001: no reply for 180s"}
]
EOF
run_case "inbox has non-merger noise only + shutdown → blocked" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":{"type":"shutdown_request"}}}' \
  2

# --- Case 5: non-shutdown SendMessage → not gated ---
echo '[]' > "$INBOX"
run_case "non-shutdown SendMessage (GO) → allowed" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":"GO — Implement TASK-001"}}' \
  0

run_case "review reply SendMessage → allowed" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","message":"APPROVED"}}' \
  0

# --- Case 6: non-SendMessage tool → ignore ---
run_case "Bash call → not gated" \
  '{"tool_name":"Bash","tool_input":{"command":"ls"}}' \
  0

run_case "Read call → not gated" \
  '{"tool_name":"Read","tool_input":{"file_path":"/app/foo"}}' \
  0

# --- Case 7: edge cases ---
run_case "empty stdin → exit 0 (defensive)" \
  '' \
  0

run_case "malformed JSON → exit 0 (defensive)" \
  'not-json{' \
  0

# --- Case 8: alternative team_name in tool_input ---
mkdir -p "$TEST_HOME/.claude/teams/custom-team/inboxes"
cat > "$TEST_HOME/.claude/teams/custom-team/inboxes/team-lead.json" <<'EOF'
[
  {"from":"merger","text":"merged TASK-001, commit=xyz"}
]
EOF
run_case "custom team_name with merger report → allowed" \
  '{"tool_name":"SendMessage","tool_input":{"to":"developer-TASK-001","team_name":"custom-team","message":{"type":"shutdown_request"}}}' \
  0

echo ""
echo "============================="
echo "Total: $((PASS + FAIL))  PASS: $PASS  FAIL: $FAIL"

[ "$FAIL" = "0" ]
