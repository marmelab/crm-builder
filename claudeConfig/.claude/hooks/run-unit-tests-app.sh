#!/bin/bash
# SubagentStop hook — unit tests (app) in each active worktree with changes.
# Exit 2 on failure → stderr injected, subagent stays alive.

LOG="$CHAT_SESSION_DIR/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] unit-app START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

REPO="${CLAUDE_PROJECT_DIR:-/app}"
cd "$REPO" || { echo "[$(date -Iseconds)] unit-app EXIT=0 cd_failed" >> "$LOG"; exit 0; }

WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/worktrees/" || true)

if [ -z "$WORKTREES" ]; then
  echo "[$(date -Iseconds)] unit-app EXIT=0 no_active_worktree" >> "$LOG"
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
    echo "[$(date -Iseconds)] unit-app SKIP wt=$WT (no changes)" >> "$LOG"
    continue
  fi

  # Skip reflection-only changes (Mode 2). See typecheck hook for rationale.
  DIFF_ALL=$( { git diff --name-only "$BASE..HEAD" 2>/dev/null; git status --porcelain | awk '{print $NF}'; } | sort -u | grep -v '^$' )
  if [ -n "$DIFF_ALL" ] && [ -z "$(echo "$DIFF_ALL" | grep -v '^docs/reflections/')" ]; then
    echo "[$(date -Iseconds)] unit-app SKIP wt=$WT (reflection-only)" >> "$LOG"
    continue
  fi

  OUTPUT=$(CI=true npm run test:unit:app 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    FAILED=1
    AGGREGATED_ERR+="=== unit-app failed in $WT ===\n$(echo "$OUTPUT" | tail -40)\n\n"
  else
    echo "[$(date -Iseconds)] unit-app OK wt=$WT" >> "$LOG"
  fi
done

if [ $FAILED -eq 1 ]; then
  printf "%b" "$AGGREGATED_ERR" >&2
  echo "[$(date -Iseconds)] unit-app EXIT=2" >> "$LOG"
  exit 2
fi

echo "[$(date -Iseconds)] unit-app EXIT=0 OK (all worktrees)" >> "$LOG"
exit 0
