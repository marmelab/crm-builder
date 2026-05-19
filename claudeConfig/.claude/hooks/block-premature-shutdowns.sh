#!/bin/bash
# PreToolUse hook — block ANY SendMessage(shutdown_request) when no merge
# report has yet arrived in the team-lead's inbox.
#
# Safety-net role: the orchestrator's prompt and the agent-team skill describe
# the correct flow (Phase 1 dispatches → wait → Phase 3 teardown after merger
# reports). This hook is the runtime guardrail in case the model collapses
# Phase 1 and Phase 3 into a single turn (which Sonnet has been observed to
# do): if any shutdown_request is sent before the merger has produced even
# one merged/merge-failed report, the hook blocks it.
#
# Why generalize from "merger-only" to "all members": in complex mode, the
# developer needs to converse with reviewers (quality-reviewer, test-validator)
# BEFORE notifying the merger. If the orchestrator pre-emptively shuts down
# the reviewers (or the dev itself), the review loop never converges — dev
# waits for replies that will never arrive. A single rule covers all of them.
#
# Trigger: tool_name == "SendMessage" AND tool_input.message contains
#          "shutdown_request" (in either string or object form).
#
# Block condition: the team-lead's inbox at
#   ~/.claude/teams/<team>/inboxes/team-lead.json
# contains zero messages from the merger matching "merged TASK-..." or
# "...merge failed". (The merger only reports those after a successful or
# failed merge attempt, which is the latest event of the per-ticket flow.)
#
# Allow condition: at least one such report exists. From that point on, the
# orchestrator is in legitimate Phase 3 territory (or per-ticket abort) and
# the hook lets the shutdowns through.
#
# Exits 2 with a stderr message that points to the agent-team skill. The
# orchestrator sees this as a tool_use_error and is forced to yield.

set -u

INPUT=$(cat)

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

PARSED=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const ti = i.tool_input || {};
  let msg = "";
  if (typeof ti.message === "string") msg = ti.message;
  else if (ti.message && typeof ti.message === "object") msg = JSON.stringify(ti.message);
  process.stdout.write(JSON.stringify({
    tool: i.tool_name || "",
    to: ti.to || "",
    msg: msg,
    teamName: ti.team_name || "tickets"
  }));
} catch { process.stdout.write("{}"); }
' "$INPUT" 2>/dev/null || echo "{}")

TOOL=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).tool || "")')
TO=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).to || "")')
MSG=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).msg || "")')
TEAM=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).teamName || "")')

if [ "$TOOL" != "SendMessage" ]; then
  exit 0
fi

# Only gate when the message is a shutdown_request.
if ! echo "$MSG" | grep -q "shutdown_request"; then
  exit 0
fi

# Sanitize team name for path (alphanumeric/dash/underscore only).
case "$TEAM" in
  *[!A-Za-z0-9_-]*|"")
    TEAM="tickets"
    ;;
esac

INBOX="${HOME:-/home/developer}/.claude/teams/$TEAM/inboxes/team-lead.json"

block_with_reason() {
  local reason="$1"
  cat >&2 <<EOF
[block-premature-shutdowns] Blocked: SendMessage(to: "$TO", shutdown_request)
before any merge has been reported.

$reason

In the agent-team workflow, shutdowns are Phase 3 — they only happen AFTER
the merger has reported "merged TASK-XXX" or "TASK-XXX merge failed" to
team-lead, ONCE per ticket of the wave. Sending shutdowns before any merge
report exists collapses Phase 1 and Phase 3 into a single turn, which kills
the team before the developer↔reviewer↔merger conversation can complete.

Required action: yield this turn (end with text only — no further tool calls)
and wait for the merger's reports. The runtime will deliver them as
<teammate-message teammate_id="merger"> blocks on a future turn. Only then
issue Phase 3 shutdowns to all members in one batch.

See chat-orchestrator.md "Trigger condition for Phase 3 — strict" and
agent-team skill Phase 3.
EOF
}

# If the inbox file doesn't exist, the merger definitely hasn't reported.
if [ ! -f "$INBOX" ]; then
  block_with_reason "The team-lead inbox at $INBOX does not exist yet."
  exit 2
fi

# Count "merged" / "merge failed" reports from the merger.
COUNT=$(node -e '
try {
  const fs = require("fs");
  const inbox = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]");
  let n = 0;
  for (const entry of (Array.isArray(inbox) ? inbox : [])) {
    if ((entry.from || "") !== "merger") continue;
    const text = (entry.text || entry.message || "").toString();
    if (/(^|\s)merged\s+TASK-/.test(text) || /merge\s+failed/.test(text) || /TASK-[A-Za-z0-9_-]+\s+merge\s+failed/.test(text)) {
      n++;
    }
  }
  process.stdout.write(String(n));
} catch { process.stdout.write("0"); }
' "$INBOX" 2>/dev/null || echo "0")

if [ "$COUNT" -lt 1 ]; then
  block_with_reason "The team-lead inbox at $INBOX has 0 messages from the merger matching \"merged TASK-...\" or \"...merge failed\"."
  exit 2
fi

# At least one merger report present — allow the shutdown.
exit 0
