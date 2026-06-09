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

# Scope to the STOPPING subagent's own worktree. SubagentStop stdin does NOT say
# which worktree the agent worked in, so the old hook conservatively LOOPED over
# every session worktree and launched a separate vitest in each. With M worktrees
# carrying changes × N developers stopping (each re-fires this hook), that's N×M
# browser-mode vitest invocations, many concurrent — they thrash the shared
# Chromium/CPU pool and a 30s run balloons past the timeout. (NB: each individual
# run was already confined by `cd`; the problem was the sheer count, not a single
# run crawling across worktrees.) Fix: derive the agent's OWN worktree from its
# transcript_path — the most-referenced /app/worktrees/<session>/(TASK-XXX|simple)
# path — and test only that one. Fall back to scan-all only if we can't parse it.
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
  # CONFINE: --root "$WT" pins Vite's project root to this worktree, so the test
  # glob and the dependency scan can never reach sibling worktrees nested under
  # /app/worktrees (which carry Deno `jsr:`/`npm:` supabase imports Vite can't
  # resolve — that breaks dep pre-bundling and stalls the run). `cd "$WT"` above
  # already does this; --root makes it explicit and robust to stray worktrees.
  #
  # SERIALIZE: flock on a container-wide lock so only ONE browser-mode vitest runs
  # at a time. Parallel developers in the same session each trigger this hook;
  # without the lock their Chromium pools thrash the shared CPU and a 30s run
  # balloons past the timeout. Serialized, every run gets full resources (~30s).
  # Sessions in separate containers (up-instance) have their own lock and stay
  # parallel. flock auto-releases if the hook is killed (fd close).
  #
  # Inner timeout 150s is well under the Claude Code hook timeout (see
  # settings.json) so we always return our own exit code — the gate — even after
  # waiting on the lock.
  flock /tmp/vitest-app.lock \
    env CI=true timeout 150 npx vitest run --config vitest.config.ts --root "$WT" > "$TMPOUT" 2>&1
  EXIT_CODE=$?
  OUTPUT=$(tail -40 "$TMPOUT")
  rm -f "$TMPOUT"
  if [ $EXIT_CODE -eq 124 ]; then
    # With confinement + serialization a clean run finishes in ~30s, so a 150s
    # timeout now genuinely means this worktree's tests hang — block it like any
    # failure so the developer investigates, instead of silently shipping.
    FAILED=1
    AGGREGATED_ERR+="=== unit-app TIMEOUT in $WT (>150s) -- tests did not finish. ===\n\n"
    echo "[$(date -Iseconds)] unit-app TIMEOUT wt=$WT (150s) BLOCKING" >> "$LOG"
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
