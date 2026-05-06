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
# How CLAUDE_AGENT_NAME and agent_type interact:
# - CLAUDE_AGENT_NAME (env var): set by the runtime to the full `name` passed to
#   Agent() — e.g. "quality-reviewer-TASK-001". Reliable when set.
# - agent_type (stdin JSON field): always present but only the base type, without
#   the TASK suffix — e.g. "quality-reviewer". Cannot give TASK_ID alone.
# - TASK_ID fallback: extracted from the tool_input JSON (file_path, command,
#   or message fields always contain TASK-XXX when a reviewer operates on its
#   worktree). If no TASK_ID found in tool_input, block conservatively.
#
# The merger is NOT gated here — it is already implicitly gated by
# validate-before-review (developer must notify both reviewers before the hook
# allows a SendMessage to merger). Blocking merger here would prevent it from
# reporting back after a merge.

set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)

# Determine agent identity. Prefer CLAUDE_AGENT_NAME (full suffixed name) when set.
# Fall back to agent_type from stdin (base type without TASK suffix).
AGENT_NAME_ENV="${CLAUDE_AGENT_NAME:-}"
AGENT_TYPE=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  process.stdout.write(i.agent_type || "");
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")

if [ -n "$AGENT_NAME_ENV" ]; then
  AGENT="$AGENT_NAME_ENV"
else
  AGENT="$AGENT_TYPE"
fi

# Determine which gate type applies (if any)
case "$AGENT" in
  quality-reviewer-*|quality-reviewer)
    GATE_TYPE="qr"
    ;;
  test-validator-*|test-validator)
    GATE_TYPE="tv"
    ;;
  merger|merger-*)
    GATE_TYPE="merger"
    ;;
  *)
    exit 0
    ;;
esac

# Extract TASK_ID: first from agent name (if it contains TASK-XXX suffix),
# then from tool_input fields (file path, command, message, recipient).
TASK_ID=$(echo "$AGENT" | grep -oE 'TASK-[0-9]+' || echo "")

if [ -z "$TASK_ID" ]; then
  # CLAUDE_AGENT_NAME not set or base type only — scan tool_input for TASK-XXX
  TASK_ID=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const inp = i.tool_input || {};
  const candidates = [
    inp.file_path || "", inp.command || "", inp.path || "",
    inp.to || "", inp.message || "",
    JSON.stringify(inp)
  ];
  for (const s of candidates) {
    const m = String(s).match(/TASK-[0-9]+/);
    if (m) { process.stdout.write(m[0]); process.exit(0); }
  }
  process.stdout.write("");
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")
fi

if [ -z "$TASK_ID" ]; then
  # No TASK_ID anywhere — block conservatively: reviewers/merger should always
  # have a TASK context; no context means something unexpected is happening.
  echo "[$(date -Iseconds)] member-idle-gate BLOCK-NOTASK agent=$AGENT gate=$GATE_TYPE (no TASK_ID in input)" >> "$LOG" 2>/dev/null || true
  cat >&2 <<EOF
[member-idle-gate] Cannot determine TASK_ID for agent '$AGENT'.
Do NOT call any tool until you receive the developer's "ready for review" SendMessage.
EOF
  exit 2
fi

# Determine the correct flag file for this gate type.
# Flags are session-scoped: <session_short>-<TASK_ID> so a stale flag from a
# previous session (same TASK-XXX name) never unblocks a reviewer in a new one.
SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
if [ -n "$SESSION_SHORT" ]; then
  case "$GATE_TYPE" in
    qr)      FLAG="/tmp/notified-qr-${SESSION_SHORT}-${TASK_ID}" ;;
    tv)      FLAG="/tmp/notified-tv-${SESSION_SHORT}-${TASK_ID}" ;;
    merger)  FLAG="/tmp/notified-merger-${SESSION_SHORT}-${TASK_ID}" ;;
    *)       exit 0 ;;
  esac
else
  case "$GATE_TYPE" in
    qr)      FLAG="/tmp/notified-qr-$TASK_ID" ;;
    tv)      FLAG="/tmp/notified-tv-$TASK_ID" ;;
    merger)  FLAG="/tmp/notified-merger-$TASK_ID" ;;
    *)       exit 0 ;;
  esac
fi

if [ ! -f "$FLAG" ]; then
  echo "[$(date -Iseconds)] member-idle-gate BLOCK agent=$AGENT task=$TASK_ID flag=$FLAG not found" >> "$LOG" 2>/dev/null || true
  cat >&2 <<EOF
[member-idle-gate] Your flag ($FLAG) does not exist yet.
The developer has not sent you a "ready for review" message.
Do NOT call any tool (Read, Bash, Grep, SendMessage…).
Idle until you receive the developer's first SendMessage.
EOF
  exit 2
fi

echo "[$(date -Iseconds)] member-idle-gate PASS agent=$AGENT task=$TASK_ID" >> "$LOG" 2>/dev/null || true
exit 0
