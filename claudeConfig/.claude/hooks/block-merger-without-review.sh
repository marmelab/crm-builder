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

# Source the canonical parser. TASK_ID is anchored at line start and only
# accepts TASK-\d+|SIMPLE|PROMOTE|ROLLBACK — so prose mentioning another ticket
# (e.g. "TASK-001 is merged; now ...") can no longer mis-key this gate, which
# was the Bug #12 root cause (the old bare /TASK-\d+/ scan keyed on the FIRST
# match anywhere in the prompt).
eval "$(node "$(dirname "$0")/lib-dispatch-parse.js" <<<"$STDIN" 2>/dev/null)"

[ "$SUBAGENT_TYPE" = "merger" ] || exit 0   # only gate merger dispatches
# SIMPLE / promotion-only / rollback dispatches carry no per-ticket review.
# (TASK_ID: SIMPLE is now structural in the orchestrator template — Step 4 — so
# this skip is reachable; previously the SIMPLE template carried no TASK_ID line
# and the skip regex was dead, accidentally relying on the empty-TASK fail-open.)
[ "$TASK_ID" = "SIMPLE" ] || [ "$TASK_ID" = "PROMOTE" ] || [ "$TASK_ID" = "ROLLBACK" ] && exit 0
[ "$MODE" = "promote" ] && exit 0
# Can't identify a per-ticket TASK: fail open (e.g. a merger dispatch without a
# TASK_ID line — same posture as before, never wedge the flow).
[ -z "$TASK_ID" ] && exit 0

Q="/tmp/review-${SESSION_SHORT}-${TASK_ID}-quality-reviewer"
T="/tmp/review-${SESSION_SHORT}-${TASK_ID}-test-validator"
MISSING=""
[ -f "$Q" ] || MISSING="quality-reviewer"
[ -f "$T" ] || MISSING="${MISSING:+$MISSING and }test-validator"
[ -z "$MISSING" ] && exit 0          # both APPROVED: allow the merge

cat >&2 <<EOF
[block-merger-without-review] Refusing to dispatch the merger for ${TASK_ID}: no APPROVED verdict from ${MISSING} yet.
The no-team flow is: developer -> quality-reviewer + test-validator -> (BOTH return APPROVED) -> merger.
Dispatch quality-reviewer-${TASK_ID} and test-validator-${TASK_ID} first (STATE B transition table), then dispatch the merger only after both APPROVED.
EOF
exit 2
