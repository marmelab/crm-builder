#!/bin/bash
# Shared helper for SubagentStop validation hooks (typecheck / prettier / unit / e2e).
#
# Sets WORKTREES to the SINGLE worktree the stopping subagent actually worked in,
# derived from its transcript (the dispatch prompt carries WORKTREE_PATH, and the
# agent's tool calls reference it repeatedly). This prevents the old "shared
# brakes" behaviour where every dev stop validated EVERY session worktree:
#   - cross-contamination (one ticket's broken state blocks an unrelated dev),
#   - spurious failures in _session (the merger's integration worktree, mid-merge),
#   - N×M redundant runs (e.g. e2e, timeout 600s, fired 32× in one session).
#
# Resolution order:
#   1. VALIDATE_WORKTREE env (explicit override), if it exists,
#   2. the agent's own worktree parsed from its transcript,
#   3. fallback: all session worktrees EXCEPT _session (never a developer's).
#
# Caller must set before sourcing+calling: STDIN, SESSION_SHORT, LOG, HOOK_TAG.
# On return, WORKTREES holds 0+ newline/space-separated worktree paths.
resolve_validate_worktree() {
  WORKTREES=""

  if [ -n "${VALIDATE_WORKTREE:-}" ] && [ -d "$VALIDATE_WORKTREE" ]; then
    WORKTREES="$VALIDATE_WORKTREE"
    return
  fi

  # Candidate transcript paths (subagent's own first, then the generic one).
  local PATHS OWN_WT="" TP
  PATHS=$(printf '%s' "$STDIN" | node -e 'try{const i=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write([i.agent_transcript_path,i.transcript_path].filter(Boolean).join("\n"))}catch(e){}' 2>/dev/null || true)
  if [ -n "$SESSION_SHORT" ] && [ -n "$PATHS" ]; then
    while IFS= read -r TP; do
      [ -n "$TP" ] && [ -f "$TP" ] || continue
      OWN_WT=$(grep -oE "/app/worktrees/${SESSION_SHORT}/(TASK-[0-9]+|simple)" "$TP" 2>/dev/null | sort | uniq -c | sort -rn | head -1 | grep -oE "/app/worktrees/[^ ]+" || true)
      [ -n "$OWN_WT" ] && [ -d "$OWN_WT" ] && break
    done <<EOF
$PATHS
EOF
  fi
  if [ -n "$OWN_WT" ] && [ -d "$OWN_WT" ]; then
    WORKTREES="$OWN_WT"
    echo "[$(date -Iseconds)] ${HOOK_TAG} SCOPED wt=$OWN_WT (from transcript)" >> "$LOG"
    return
  fi

  # Fallback: all session worktrees EXCEPT _session (merger's integration tree).
  if [ -n "$SESSION_SHORT" ]; then
    WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/app/worktrees/${SESSION_SHORT}/" | grep -v "/_session$" || true)
  else
    WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/app/worktrees/" | grep -v "/_session$" || true)
  fi
  [ -n "$WORKTREES" ] && echo "[$(date -Iseconds)] ${HOOK_TAG} SCAN-ALL (transcript scope unavailable)" >> "$LOG"
}
