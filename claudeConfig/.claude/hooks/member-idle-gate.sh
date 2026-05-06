#!/bin/bash
# PreToolUse hook — prevents quality-reviewer-*, test-validator-*, and merger
# from using any tool before receiving their first message from the developer.
#
# Rationale: reviewers and merger are dispatched simultaneously with the
# developer. Without this gate:
#   - Reviewers read the (empty) worktree and send unsolicited "branch is
#     clean" messages, confusing the developer and breaking the review loop.
#   - Merger sends an idle_notification to team-lead on spawn, which the
#     orchestrator misreads as a completion signal and attempts a premature
#     shutdown batch (caught by block-premature-shutdowns.sh, but noisy).
#
# Mechanism: check the agent's inbox inside the shared "tickets" team.
# Empty / absent → block all tool calls. Non-empty → allow (developer has
# sent at least one message, e.g. "ready, please review").

set -u

AGENT="${CLAUDE_AGENT_NAME:-}"

case "$AGENT" in
  quality-reviewer-*|test-validator-*|merger)
    : # gate applies
    ;;
  *)
    exit 0
    ;;
esac

INBOX="${HOME:-/home/developer}/.claude/teams/tickets/inboxes/$AGENT.json"

if [ ! -f "$INBOX" ]; then
  cat >&2 <<'EOF'
[reviewer-idle-gate] Your inbox does not exist yet — the developer has not
sent you a message. Do NOT call any tool (Read, Bash, Grep, SendMessage…).
Idle until you receive the developer's first SendMessage.
EOF
  exit 2
fi

COUNT=$(node -e '
try {
  const fs = require("fs");
  const msgs = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]");
  process.stdout.write(String(Array.isArray(msgs) ? msgs.length : 0));
} catch { process.stdout.write("0"); }
' "$INBOX" 2>/dev/null || echo "0")

if [ "$COUNT" -lt 1 ]; then
  cat >&2 <<'EOF'
[reviewer-idle-gate] Your inbox is empty — the developer has not sent a
message yet. Do NOT call any tool (Read, Bash, Grep, SendMessage…).
Idle until you receive the developer's first SendMessage.
EOF
  exit 2
fi

exit 0
