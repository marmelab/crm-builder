#!/bin/bash
# PreToolUse/Agent hook (no-team flow) — block the session->main PROMOTION while
# any developed-but-unmerged task branch still exists.
#
# WHY: in no-team mode the orchestrator tracks each wave's tickets in its own
# context (mental state) across many background turns. A ticket that finishes
# early and out-of-band can be lost between its developer's DONE and the
# REVIEW->MERGE transition — the orchestrator never dispatches its reviewers/
# merger, the ticket's branch is never merged into session/<SHORT>, yet the
# orchestrator believes the wave is done and dispatches the promotion merger.
# The work silently never reaches main (observed: TASK-002 in session c44e44d5,
# whose i18n branch was committed but never merged; the feature only shipped
# because TASK-003 happened to redo it).
#
# This hook is the deterministic backstop: when the orchestrator dispatches the
# promotion merger (subagent_type=merger, prompt contains "MODE: promote"), it
# refuses (exit 2) if any branch under refs/heads/<SHORT>/ has commits not yet
# reachable from session/<SHORT>. The block message lists the offending branches
# so the orchestrator can drive them through REVIEW->MERGE before retrying.
#
# Behavioural counterpart: chat-orchestrator.md STATE B Step 3 reconciles
# against disk before promoting, so in the normal case this hook never fires.

set -u

STDIN=$(cat)

# Source the canonical parser: AGENT_TYPE ("" for the main orchestrator),
# SUBAGENT_TYPE, MODE (=promote for the promotion dispatch), SESSION_SHORT_ID.
eval "$(node "$(dirname "$0")/lib-dispatch-parse.js" <<<"$STDIN" 2>/dev/null)"
SHORT="$SESSION_SHORT_ID"

# Only gate the orchestrator's promotion-merger dispatch.
[ -z "$AGENT_TYPE" ] || exit 0          # a subagent is calling — not our concern
[ "$SUBAGENT_TYPE" = "merger" ] || exit 0
[ "$MODE" = "promote" ] || exit 0

[ -z "$SHORT" ] && SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
[ -z "$SHORT" ] && exit 0

APP_DIR=${APP_DIR:-/app}
# No session branch yet → nothing to guard.
git -C "$APP_DIR" show-ref --verify --quiet "refs/heads/session/$SHORT" || exit 0

# Every task branch lives under refs/heads/<SHORT>/ (e.g. <SHORT>/TASK-001,
# <SHORT>/feature/foo, <SHORT>/simple). session/<SHORT> and session-base/<SHORT>
# have a different prefix and are not matched.
UNMERGED=""
while IFS= read -r br; do
  [ -z "$br" ] && continue
  n=$(git -C "$APP_DIR" rev-list --count "session/$SHORT..$br" 2>/dev/null || echo 0)
  if [ "${n:-0}" -gt 0 ] 2>/dev/null; then
    UNMERGED="${UNMERGED}  - ${br} (${n} unmerged commit(s))
"
  fi
done < <(git -C "$APP_DIR" for-each-ref --format='%(refname:short)' "refs/heads/$SHORT" 2>/dev/null)

if [ -n "$UNMERGED" ]; then
  cat >&2 <<EOF
[block-promote-unmerged] Refusing to promote session/$SHORT to main — these task branches have commits NOT yet merged into the session branch:
$UNMERGED
A ticket was developed but never merged into session/$SHORT (its reviewers/merger were likely never dispatched). Before promoting, for EACH branch above:
  - drive its ticket through the normal REVIEW -> MERGE transitions (dispatch its quality-reviewer + test-validator if not done, then its per-ticket merger), so its work lands on session/$SHORT.
Re-dispatch the promotion merger only once this list is empty.
EOF
  exit 2
fi

exit 0
