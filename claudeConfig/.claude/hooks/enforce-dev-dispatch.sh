#!/bin/bash
# PreToolUse hook on the Agent tool (no-team flow).
#
# Forces `developer` dispatches to use the session worktree that setup-worktree
# already created (`WORKTREE_PATH:` in the prompt) and forbids the Agent tool's
# own `isolation: worktree`, which spawns off-convention `worktree-agent-*`
# branches outside the session-branch topology — breaking Stage A merges and the
# migration diff baseline. Keeps the orchestrator on the STATE B dispatch
# template instead of improvising a free-form prompt.
set -u

INPUT=$(cat)

# Source the canonical parser: SUBAGENT_TYPE, ISOLATION, WORKTREE_PATH.
eval "$(node "$(dirname "$0")/lib-dispatch-parse.js" <<<"$INPUT" 2>/dev/null)"

# Only gate the COMPLEX `developer` dispatch. `simple-developer` is intentionally
# NOT gated here: setup-worktree.sh derives the fixed <SHORT>/simple worktree from
# CHAT_SESSION_DIR when the SIMPLE template omits WORKTREE_PATH, so a missing
# WORKTREE_PATH is not fatal for it (the COMPLEX developer has no such fallback —
# its worktree path is per-ticket and must be carried explicitly). The SIMPLE
# templates do carry WORKTREE_PATH today, but this gate stays developer-only so
# the SIMPLE fallback path remains valid.
[ "$SUBAGENT_TYPE" = "developer" ] || exit 0

if [ "$ISOLATION" = "worktree" ]; then
  echo "[enforce-dev-dispatch] developer must NOT use isolation:worktree — setup-worktree already created /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX. Drop isolation and pass WORKTREE_PATH + BRANCH_NAME in the prompt (STATE B template)." >&2
  exit 2
fi

if [ -z "$WORKTREE_PATH" ]; then
  echo "[enforce-dev-dispatch] developer dispatch prompt is missing 'WORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX' (and BRANCH_NAME). Use the STATE B dispatch template verbatim instead of a free-form prompt." >&2
  exit 2
fi

exit 0
