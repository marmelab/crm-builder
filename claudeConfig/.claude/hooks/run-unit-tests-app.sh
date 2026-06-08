#!/bin/bash
# SubagentStop hook -- unit tests (app) in each active worktree with changes.
# Exit 2 on failure -> stderr injected, subagent stays alive.

LOG="$CHAT_SESSION_DIR/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
STDIN=$(cat)
echo "[$(date -Iseconds)] unit-app START pwd=$(pwd) CLAUDE_PROJECT_DIR=$CLAUDE_PROJECT_DIR" >> "$LOG"

REPO="${CLAUDE_PROJECT_DIR:-/app}"
cd "$REPO" || { echo "[$(date -Iseconds)] unit-app EXIT=0 cd_failed" >> "$LOG"; exit 0; }

SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)

# Scope to the STOPPING subagent's own worktree. Browser-mode vitest is heavy
# and racy: when N developers stop near-simultaneously, the old "scan every
# worktree" behaviour launched N parallel hooks × N worktrees = N² vitest runs,
# all fighting over Vite dev-server ports and the shared Chromium pool. That is
# the root cause of the 150s hangs. The SubagentStop stdin gives us the
# subagent's transcript_path; the developer has been `cd`-ing into its worktree
# all along, so the most-referenced /app/worktrees/<session>/(TASK-XXX|simple)
# path in that transcript is its worktree. Fall back to scan-all only if we
# can't parse it (e.g. transcript missing), preserving previous behaviour.
WORKTREES=""
if [ -n "${VALIDATE_WORKTREE:-}" ] && [ -d "$VALIDATE_WORKTREE" ]; then
  WORKTREES="$VALIDATE_WORKTREE"
else
  TRANSCRIPT=$(printf '%s' "$STDIN" | node -e 'try{const i=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(i.transcript_path||"")}catch(e){}' 2>/dev/null || true)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && [ -n "$SESSION_SHORT" ]; then
    OWN_WT=$(grep -oE "/app/worktrees/${SESSION_SHORT}/(TASK-[0-9]+|simple)" "$TRANSCRIPT" 2>/dev/null | sort | uniq -c | sort -rn | head -1 | grep -oE "/app/worktrees/[^ ]+" || true)
    if [ -n "$OWN_WT" ] && [ -d "$OWN_WT" ]; then
      WORKTREES="$OWN_WT"
      echo "[$(date -Iseconds)] unit-app SCOPED wt=$OWN_WT (from transcript)" >> "$LOG"
    fi
  fi
fi
# Fallback: scan all session worktrees (couldn't determine the stopping agent's own).
if [ -z "$WORKTREES" ]; then
  if [ -n "$SESSION_SHORT" ]; then
    WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/app/worktrees/${SESSION_SHORT}/" || true)
  else
    WORKTREES=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep "^/app/worktrees/" || true)
  fi
  [ -n "$WORKTREES" ] && echo "[$(date -Iseconds)] unit-app SCAN-ALL (transcript scope unavailable)" >> "$LOG"
fi

if [ -z "$WORKTREES" ]; then
  echo "[$(date -Iseconds)] unit-app EXIT=0 no_active_worktree" >> "$LOG"
  exit 0
fi

# Kill ONLY orphan Chromium from previous timed-out runs, never a sibling hook's
# live browser. `timeout 150 npx vitest` kills the vitest node process but leaves
# its Chromium children alive, holding the Vite dev-server port — so the next run
# wastes its whole budget searching for a free port. We must NOT kill a Chromium
# that a concurrently-running sibling hook is still using (that reintroduces the
# hang). A live browser tree always has a vitest node process somewhere up its
# ancestor chain; an orphaned tree (parent vitest gone) does not. So: for each
# chrome-headless-shell process, walk its PPID chain up to init — keep it if ANY
# ancestor's cmdline contains "vitest", otherwise kill it.
ancestor_has_vitest() {
  local pid="$1" depth=0 cmd ppid
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 20 ]; do
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in *vitest*) return 0 ;; esac
    ppid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null || echo 1)
    [ -z "$ppid" ] && ppid=1
    pid="$ppid"; depth=$((depth + 1))
  done
  return 1
}
for CPID in $(pgrep -f 'chrome-headless-shell' 2>/dev/null || true); do
  if ancestor_has_vitest "$CPID"; then
    continue  # live browser owned by a running vitest → keep
  fi
  kill "$CPID" 2>/dev/null && echo "[$(date -Iseconds)] unit-app ORPHAN_KILLED pid=$CPID" >> "$LOG" || true
done

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

  # Skip ADR-only diffs (.md docs, no test impact).
  DIFF_ALL=$( { git diff --name-only "$BASE..HEAD" 2>/dev/null; git status --porcelain | awk '{print $NF}'; } | sort -u | grep -v '^$' )
  if [ -n "$DIFF_ALL" ] && [ -z "$(echo "$DIFF_ALL" | grep -v '^adr/')" ]; then
    echo "[$(date -Iseconds)] unit-app SKIP wt=$WT (adr-only)" >> "$LOG"
    continue
  fi

  # Call vitest directly with `run` subcommand (not `npm run test:unit:app`)
  # because the package.json script invokes `vitest --config ...` without `run`,
  # which puts vitest into watch mode. In a non-TTY agent context, watch mode
  # hangs at startup instead of running tests once and exiting.
  # Use a temp file instead of $() -- avoids blocking if vitest worker processes
  # keep the stdout pipe open after the main process exits.
  TMPOUT=$(mktemp)
  # Inner timeout is 150s, 30s shorter than the 180s Claude Code hook timeout,
  # so the script can detect the outcome and return before Claude Code kills it.
  CI=true timeout 150 npx vitest run --config vitest.config.ts > "$TMPOUT" 2>&1
  EXIT_CODE=$?
  OUTPUT=$(tail -40 "$TMPOUT")
  rm -f "$TMPOUT"
  if [ $EXIT_CODE -eq 124 ]; then
    # A 150s timeout is an INFRASTRUCTURE problem, not a test failure: browser-mode
    # vitest (Playwright/Chromium + un-pre-bundled module serving) intermittently
    # stalls at startup in this worktree environment. Treating it as a failure was
    # the original disaster — it injected "tests may be hanging" into the developer,
    # who then abandoned its feature work to debug vitest internals, looping against
    # the circuit breaker for hours and burning the session. A timeout tells us
    # nothing about the developer's code, so we DO NOT block on it: log it for
    # observability and move on. Real test failures (vitest exit 1) below still
    # gate normally, and typecheck/prettier/unit-functions remain hard gates.
    echo "[$(date -Iseconds)] unit-app TIMEOUT wt=$WT (150s) -- NON-BLOCKING (infra, vitest browser stall)" >> "$LOG"
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
