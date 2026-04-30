#!/bin/bash
# SubagentStop hook — prettier check in the project repo + any active worktree.
# Exit 2 on failure → stderr injected, subagent stays alive to run prettier:apply.

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] prettier START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

REPO="${CLAUDE_PROJECT_DIR:-/app}"
cd "$REPO" || { echo "[$(date -Iseconds)] prettier EXIT=0 cd_failed" >> "$LOG"; exit 0; }

# Only check ACTIVE feature worktrees under /worktrees/. See typecheck hook
# for the rationale (skip main repo — pre-existing state is not our concern).
WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/worktrees/" || true)

if [ -z "$WORKTREES" ]; then
  echo "[$(date -Iseconds)] prettier EXIT=0 no_active_worktree" >> "$LOG"
  exit 0
fi

FAILED=0
AGGREGATED_ERR=""
for WT in $WORKTREES; do
  cd "$WT" || continue
  CHANGED=$(git status --porcelain)
  BASE=$(git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null)
  AHEAD=$(git log --oneline "$BASE..HEAD" 2>/dev/null)
  if [ -z "$CHANGED" ] && [ -z "$AHEAD" ]; then
    echo "[$(date -Iseconds)] prettier SKIP wt=$WT (no changes)" >> "$LOG"
    continue
  fi

  OUTPUT=$(npm run prettier 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    FAILED=1
    AGGREGATED_ERR+="=== prettier failed in $WT ===\n$(echo "$OUTPUT" | tail -15)\n\n"
  else
    echo "[$(date -Iseconds)] prettier OK wt=$WT" >> "$LOG"
  fi
done

if [ $FAILED -eq 1 ]; then
  echo "Prettier check failed — run 'npm run prettier:apply' in the worktree(s) below:" >&2
  printf "%b" "$AGGREGATED_ERR" >&2
  echo "[$(date -Iseconds)] prettier EXIT=2" >> "$LOG"
  exit 2
fi

echo "[$(date -Iseconds)] prettier EXIT=0 OK (all worktrees)" >> "$LOG"
exit 0
