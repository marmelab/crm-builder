#!/bin/bash
# SubagentStop hook — runs typecheck on the project repo + any active worktree.
# Exit 2 on failure → stderr injected as error, subagent stays alive to fix.

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] typecheck START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR MODE=$MODE stdin_len=${#STDIN}" >> "$LOG"

REPO="${CLAUDE_PROJECT_DIR:-/app}"
cd "$REPO" || { echo "[$(date -Iseconds)] typecheck EXIT=0 cd_failed" >> "$LOG"; exit 0; }

# Only check ACTIVE feature worktrees under /worktrees/. The main repo ($REPO,
# usually /app) is the merge target — pre-existing state there is not the current
# subagent's concern. Running typecheck on /app with orphan untracked files from
# previous sessions caused a regression where a developer deviated from its task
# to "fix" unrelated typecheck errors.
WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/worktrees/" || true)

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

  OUTPUT=$(npm run typecheck 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    FAILED=1
    AGGREGATED_ERR+="=== typecheck failed in $WT ===\n$(echo "$OUTPUT" | tail -20)\n\n"
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
