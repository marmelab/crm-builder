#!/bin/bash
# PreToolUse hook on the Agent tool (no-team flow).
#
# Blocks dispatching a merger for a real feature ticket until BOTH reviewers
# (quality-reviewer + test-validator) have recorded APPROVED for that ticket.
# This is the no-team replacement for validate-before-review.sh: with no
# SendMessage handshake, nothing otherwise stops the orchestrator from going
# developer -> merger directly and skipping review. The gate enforces the
# intended dev -> reviewers -> (both APPROVED) -> merger ordering structurally.
#
# Verdicts are recorded by record-review-verdict.sh (SubagentStop) as flags:
#   /tmp/review-<SESSION_SHORT>-<TASK>-<quality-reviewer|test-validator>
#
# Skipped for the SIMPLE flow and the promotion-only dispatch (no per-ticket
# review), and when the ticket can't be identified (fail open, never wedge).
set -u

SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
[ -z "$SESSION_SHORT" ] && exit 0

STDIN=$(cat)

INFO=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const t = i.tool_input || {};
  const st = t.subagent_type || "";
  const pr = t.prompt || "";
  const task = (pr.match(/TASK-\d+/) || [""])[0];
  const skip = (/TASK_ID:\s*(SIMPLE|PROMOTE)/.test(pr) || /MODE:\s*promote/.test(pr)) ? "1" : "0";
  process.stdout.write([st, task, skip].join("|"));
} catch (e) { process.stdout.write("||") }
' "$STDIN" 2>/dev/null || echo "||")

ST="${INFO%%|*}"; REST="${INFO#*|}"; TASK="${REST%%|*}"; SKIP="${REST##*|}"

[ "$ST" = "merger" ] || exit 0       # only gate merger dispatches
[ "$SKIP" = "1" ] && exit 0          # SIMPLE flow / promotion-only: no per-ticket review
[ -z "$TASK" ] && exit 0             # can't identify the ticket: fail open

Q="/tmp/review-${SESSION_SHORT}-${TASK}-quality-reviewer"
T="/tmp/review-${SESSION_SHORT}-${TASK}-test-validator"
MISSING=""
[ -f "$Q" ] || MISSING="quality-reviewer"
[ -f "$T" ] || MISSING="${MISSING:+$MISSING and }test-validator"
[ -z "$MISSING" ] && exit 0          # both APPROVED: allow the merge

cat >&2 <<EOF
[block-merger-without-review] Refusing to dispatch the merger for ${TASK}: no APPROVED verdict from ${MISSING} yet.
The no-team flow is: developer -> quality-reviewer + test-validator -> (BOTH return APPROVED) -> merger.
Dispatch quality-reviewer-${TASK} and test-validator-${TASK} first (STATE B transition table), then dispatch the merger only after both APPROVED.
EOF
exit 2
