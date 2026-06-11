#!/bin/bash
# SubagentStop hook — runs typecheck on the project repo + any active worktree.
# Exit 2 on failure → stderr injected as error, subagent stays alive to fix.

LOG="$CHAT_SESSION_DIR/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] typecheck START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR MODE=$MODE stdin_len=${#STDIN}" >> "$LOG"

REPO="${CLAUDE_PROJECT_DIR:-/app}"
cd "$REPO" || { echo "[$(date -Iseconds)] typecheck EXIT=0 cd_failed" >> "$LOG"; exit 0; }

# Only check ACTIVE feature worktrees under /app/worktrees/. The main repo ($REPO,
# usually /app) is the merge target — pre-existing state there is not the current
# subagent's concern. Running typecheck on /app with orphan untracked files from
# previous sessions caused a regression where a developer deviated from its task
# to "fix" unrelated typecheck errors.
#
# Scope to the stopping subagent's own worktree via the shared resolver — see
# resolve-validate-worktree.sh for why fanning out to every worktree is harmful.
SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
HOOK_TAG="typecheck"
. /home/developer/.claude/hooks/resolve-validate-worktree.sh
resolve_validate_worktree

if [ -z "$WORKTREES" ]; then
  echo "[$(date -Iseconds)] typecheck EXIT=0 no_active_worktree" >> "$LOG"
  exit 0
fi

FAILED=0
AGGREGATED_ERR=""
for WT in $WORKTREES; do
  cd "$WT" || continue
  # Skip if worktree has no changes vs base
  CHANGED=$(git status --porcelain)
  BASE=$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null)
  AHEAD=$(git log --oneline "$BASE..HEAD" 2>/dev/null)
  if [ -z "$CHANGED" ] && [ -z "$AHEAD" ]; then
    echo "[$(date -Iseconds)] typecheck SKIP wt=$WT (no changes)" >> "$LOG"
    continue
  fi

  # Skip if every changed path is under adr/. ADRs are .md docs and don't
  # affect typecheck; running npm run typecheck on a doc-only commit wastes
  # ~10-20s per ADR. Mirrors the previous reflection-only skip.
  DIFF_ALL=$( { git diff --name-only "$BASE..HEAD" 2>/dev/null; git status --porcelain | awk '{print $NF}'; } | sort -u | grep -v '^$' )
  if [ -n "$DIFF_ALL" ] && [ -z "$(echo "$DIFF_ALL" | grep -v '^adr/')" ]; then
    echo "[$(date -Iseconds)] typecheck SKIP wt=$WT (adr-only)" >> "$LOG"
    continue
  fi

  OUTPUT=$(npm run typecheck 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    FAILED=1
    AGGREGATED_ERR+="=== typecheck failed in $WT ===\n$(echo "$OUTPUT" | tail -20)\n\n"
    echo "[$(date -Iseconds)] typecheck FAIL wt=$WT EXIT=$EXIT_CODE" >> "$LOG"
  else
    echo "[$(date -Iseconds)] typecheck OK wt=$WT" >> "$LOG"
  fi
done

if [ $FAILED -eq 1 ]; then
  echo "Typecheck failed — fix TypeScript errors before completing:" >&2
  printf "%b" "$AGGREGATED_ERR" >&2
  echo "[$(date -Iseconds)] typecheck EXIT=2" >> "$LOG"
  exit 2
fi

echo "[$(date -Iseconds)] typecheck EXIT=0 OK (all worktrees)" >> "$LOG"
exit 0
