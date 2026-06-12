#!/bin/bash
# claudeConfig/.claude/hooks/test/record-review-verdict.test.sh
set -e
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$HOOKS_DIR/record-review-verdict.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP" /tmp/review-deadbeef-*' EXIT
export CHAT_SESSION_DIR="$TMP/deadbeef-aaaa"
export HOME="$TMP/home"
mkdir -p "$CHAT_SESSION_DIR" "$HOME"
LOG="$CHAT_SESSION_DIR/hooks.log"

# Case 1: missing identity (empty agent_type, no transcript, no verdict source).
# Must log role=UNKNOWN task=UNKNOWN (never TASK-001) and write NO approval flag.
echo '{"agent_type":""}' | bash "$HOOK"
LINE=$(tail -n1 "$LOG")
echo "$LINE" | grep -q "task=UNKNOWN" || { echo "FAIL: missing-identity must log task=UNKNOWN, got: $LINE"; exit 1; }
echo "$LINE" | grep -q "TASK-001" && { echo "FAIL: must NOT log misleading TASK-001, got: $LINE"; exit 1; }
echo "$LINE" | grep -q "role=UNKNOWN" || { echo "FAIL: missing-identity must log role=UNKNOWN, got: $LINE"; exit 1; }
# No approval flag for any task in this session.
if ls /tmp/review-deadbeef-* >/dev/null 2>&1; then
  echo "FAIL: missing-identity must NOT write an approval flag"; exit 1
fi

# Case 2: a properly-identified reviewer with APPROVED still records the flag
# (gate behavior unchanged). agent_type carries role+task; verdict via
# last_assistant_message.
echo '{"agent_type":"quality-reviewer-TASK-007","last_assistant_message":"APPROVED"}' | bash "$HOOK"
[ -e "/tmp/review-deadbeef-TASK-007-quality-reviewer" ] || { echo "FAIL: identified APPROVED must write the flag"; exit 1; }

# Case 3: REJECTED clears a prior flag (gate behavior unchanged).
echo '{"agent_type":"quality-reviewer-TASK-007","last_assistant_message":"REJECTED: do X"}' | bash "$HOOK"
[ ! -e "/tmp/review-deadbeef-TASK-007-quality-reviewer" ] || { echo "FAIL: identified REJECTED must clear the flag"; exit 1; }

echo "OK record-review-verdict"
