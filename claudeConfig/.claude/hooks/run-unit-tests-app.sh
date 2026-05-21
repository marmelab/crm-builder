#!/bin/bash
# SubagentStop hook -- unit tests (app) in each active worktree with changes.
# Exit 2 on failure -> stderr injected, subagent stays alive.

LOG="$CHAT_SESSION_DIR/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] unit-app START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

REPO="${CLAUDE_PROJECT_DIR:-/app}"
cd "$REPO" || { echo "[$(date -Iseconds)] unit-app EXIT=0 cd_failed" >> "$LOG"; exit 0; }

# VALIDATE_WORKTREE narrows to one worktree (set by validate-before-review.sh).
# See typecheck hook header for rationale.
SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
if [ -n "${VALIDATE_WORKTREE:-}" ] && [ -d "$VALIDATE_WORKTREE" ]; then
  WORKTREES="$VALIDATE_WORKTREE"
elif [ -n "$SESSION_SHORT" ]; then
  WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/app/worktrees/${SESSION_SHORT}/" || true)
else
  WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/app/worktrees/" || true)
fi

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

  # Call vitest directly with `run` subcommand (not `npm run test:unit:app`)
  # because the package.json script invokes `vitest --config ...` without `run`,
  # which puts vitest into watch mode. In a non-TTY agent context, watch mode
  # hangs at startup instead of running tests once and exiting.
  # Use a temp file instead of $() -- avoids blocking if vitest worker processes
  # keep the stdout pipe open after the main process exits.
  TMPOUT=$(mktemp)
  CI=true timeout 180 npx vitest run --config vitest.config.ts > "$TMPOUT" 2>&1
  EXIT_CODE=$?
  OUTPUT=$(tail -40 "$TMPOUT")
  rm -f "$TMPOUT"
  if [ $EXIT_CODE -eq 124 ]; then
    echo "[$(date -Iseconds)] unit-app TIMEOUT wt=$WT (180s)" >> "$LOG"
    FAILED=1
    AGGREGATED_ERR+="=== unit-app TIMEOUT in $WT (>180s) -- vitest did not exit. Tests may be hanging. ===\n\n"
    continue
  fi
  if [ $EXIT_CODE -ne 0 ]; then
    FAILED=1
    AGGREGATED_ERR+="=== unit-app failed in $WT ===\n$(echo "$OUTPUT")\n\n"
    echo "[$(date -Iseconds)] unit-app FAIL wt=$WT EXIT=$EXIT_CODE" >> "$LOG"
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
