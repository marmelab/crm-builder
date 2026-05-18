#!/bin/bash
# SubagentStop hook — removes session worktrees after the merger completes.
# Matcher: "merger" — only fires when a merger agent stops.
#
# Guard: only removes worktrees whose branch has an explicit merge commit in
# master. If the merger stopped prematurely (before merging), the merge commit
# does not exist and the worktree is preserved.

set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# In rollback mode the merger finalises a `git revert` on /app — no worktree
# to clean up.
if [ "${CLAUDE_ROLLBACK_MODE:-}" = "1" ]; then
  echo "[$(date -Iseconds)] cleanup-worktree SKIP rollback mode" >> "$LOG" 2>/dev/null || true
  exit 0
fi

SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
if [ -z "$SESSION_SHORT" ]; then
  echo "[$(date -Iseconds)] cleanup-worktree SKIP no SESSION_SHORT" >> "$LOG" 2>/dev/null || true
  exit 0
fi

WORKTREE_BASE="/app/worktrees/$SESSION_SHORT"
if [ ! -d "$WORKTREE_BASE" ]; then
  echo "[$(date -Iseconds)] cleanup-worktree SKIP $WORKTREE_BASE not found" >> "$LOG" 2>/dev/null || true
  exit 0
fi

echo "[$(date -Iseconds)] cleanup-worktree START session=$SESSION_SHORT base=$WORKTREE_BASE" >> "$LOG" 2>/dev/null || true

REMOVED=0
SKIPPED=0
BRANCHES_TO_DELETE=()

while IFS= read -r line; do
  if [[ "$line" == worktree\ * ]]; then
    CURRENT_PATH="${line#worktree }"
    CURRENT_BRANCH=""
  elif [[ "$line" == branch\ * ]]; then
    CURRENT_BRANCH="${line#branch refs/heads/}"
  elif [[ -z "$line" ]]; then
    if [[ "$CURRENT_PATH" == "$WORKTREE_BASE"/* ]] || [[ "$CURRENT_PATH" == "$WORKTREE_BASE" ]]; then
      # Guard: only remove if merger has explicitly merged this branch (merge commit present in master)
      if [ -n "$CURRENT_BRANCH" ]; then
        MERGE_COMMIT=$(git -C /app log --merges --oneline -100 2>/dev/null | grep "'${CURRENT_BRANCH}'" | head -1)
        if [ -z "$MERGE_COMMIT" ]; then
          echo "[$(date -Iseconds)] cleanup-worktree SKIP-UNMERGED $CURRENT_PATH branch=$CURRENT_BRANCH (no merge commit in master)" >> "$LOG" 2>/dev/null || true
          SKIPPED=$((SKIPPED + 1))
          continue
        fi
      fi
      [ -n "$CURRENT_BRANCH" ] && BRANCHES_TO_DELETE+=("$CURRENT_BRANCH")
      if git -C /app worktree remove --force "$CURRENT_PATH" 2>/dev/null; then
        echo "[$(date -Iseconds)] cleanup-worktree REMOVED $CURRENT_PATH" >> "$LOG" 2>/dev/null || true
      else
        rm -rf "$CURRENT_PATH"
        echo "[$(date -Iseconds)] cleanup-worktree RM-RF $CURRENT_PATH" >> "$LOG" 2>/dev/null || true
      fi
      REMOVED=$((REMOVED + 1))
    fi
  fi
done < <(git -C /app worktree list --porcelain 2>/dev/null; echo "")

for branch in "${BRANCHES_TO_DELETE[@]:-}"; do
  [ -z "$branch" ] && continue
  git -C /app branch -d "$branch" 2>/dev/null || git -C /app branch -D "$branch" 2>/dev/null || true
  echo "[$(date -Iseconds)] cleanup-worktree BRANCH-DELETED $branch" >> "$LOG" 2>/dev/null || true
done

git -C /app worktree prune 2>/dev/null || true

# Remove leftover dirs not registered as git worktrees
REGISTERED=$(git -C /app worktree list --porcelain 2>/dev/null | grep '^worktree ' | sed 's/^worktree //')
find "$WORKTREE_BASE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r d; do
  if ! echo "$REGISTERED" | grep -qF "$d"; then
    rm -rf "$d"
    echo "[$(date -Iseconds)] cleanup-worktree LEFTOVER RM $d" >> "$LOG" 2>/dev/null || true
  fi
done

rmdir "$WORKTREE_BASE" 2>/dev/null || true

echo "[$(date -Iseconds)] cleanup-worktree EXIT=0 removed=$REMOVED skipped=$SKIPPED session=$SESSION_SHORT" >> "$LOG" 2>/dev/null || true
exit 0
