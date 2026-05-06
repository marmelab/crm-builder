#!/bin/bash
# PreToolUse hook — prevents quality-reviewer-* and test-validator-* from
# using any tool before the developer has sent them a "ready for review" message.
#
# Rationale: reviewers are dispatched simultaneously with the developer. Without
# this gate they read an empty worktree and send unsolicited "nothing to review"
# messages, confusing the developer and breaking the review loop.
#
# Why NOT check the team inbox file:
# Reviewers are dispatched with their task context already in the spawn prompt
# (a <teammate-message> from team-lead). The inbox therefore contains 1 message
# immediately at spawn time — an inbox-based COUNT >= 1 check would always pass
# and never block. The /tmp flag approach is the correct signal: it is only
# written by validate-before-review.sh when the developer explicitly validates
# and sends a "ready for review" message, which is a strictly later event.
#
# Mechanism: check for the flag file that validate-before-review.sh writes when
# the developer successfully validates and then sends a message to this reviewer:
#   /tmp/notified-qr-TASK-XXX  (quality-reviewer-TASK-XXX)
#   /tmp/notified-tv-TASK-XXX  (test-validator-TASK-XXX)
#
# The merger is NOT gated here — it is already implicitly gated by
# validate-before-review (developer must notify both reviewers before the hook
# allows a SendMessage to merger). Blocking merger here would prevent it from
# reporting back after a merge.

set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"

AGENT="${CLAUDE_AGENT_NAME:-}"

case "$AGENT" in
  quality-reviewer-*|test-validator-*|merger|merger-*)
    : # gate applies
    ;;
  *)
    exit 0
    ;;
esac

# Extract the TASK-XXX id from the agent name (e.g. quality-reviewer-TASK-001 → TASK-001)
TASK_ID=$(echo "$AGENT" | grep -oE 'TASK-[0-9]+' || echo "")

if [ -z "$TASK_ID" ]; then
  # Unexpected name format — log and let through rather than hard-blocking.
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  echo "[$(date -Iseconds)] member-idle-gate WARN agent=$AGENT no TASK_ID found, letting through" >> "$LOG" 2>/dev/null || true
  exit 0
fi

case "$AGENT" in
  quality-reviewer-*)
    FLAG="/tmp/notified-qr-$TASK_ID"
    ;;
  test-validator-*)
    FLAG="/tmp/notified-tv-$TASK_ID"
    ;;
  merger|merger-*)
    FLAG="/tmp/notified-merger-$TASK_ID"
    ;;
  *)
    exit 0
    ;;
esac

if [ ! -f "$FLAG" ]; then
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  echo "[$(date -Iseconds)] member-idle-gate BLOCK agent=$AGENT task=$TASK_ID flag=$FLAG not found" >> "$LOG" 2>/dev/null || true
  cat >&2 <<EOF
[member-idle-gate] Your flag ($FLAG) does not exist yet.
The developer has not sent you a "ready for review" message.
Do NOT call any tool (Read, Bash, Grep, SendMessage…).
Idle until you receive the developer's first SendMessage.
EOF
  exit 2
fi

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
echo "[$(date -Iseconds)] member-idle-gate PASS agent=$AGENT task=$TASK_ID" >> "$LOG" 2>/dev/null || true
exit 0
