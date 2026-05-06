#!/bin/bash
# PreToolUse hook for SendMessage tool.
# When the developer is about to SendMessage a reviewer or the merger, run
# the project validation chain. If any step fails, exit 2 to block the
# SendMessage; the dev sees the stderr as a tool_use_error.
#
# Why gate reviewers AND merger:
# - If validation fails (typecheck, unit, etc.), the dev must fix and commit
#   again — and the reviewers must re-evaluate the new commit. Letting them
#   review a broken state would waste their cycle on issues the gate would
#   have caught. So reviewers must see only validated commits.
# - The SHA cache below makes the cost of validating before every reviewer
#   message essentially zero on un-changed HEADs: the typical "dev SendMessages
#   reviewer-A then reviewer-B" pair runs the chain once for A, then hits the
#   cache for B (~10ms instead of ~60s).
#
# Behavior:
# - Reads the tool input JSON from stdin.
# - Skips for non-reviewer/non-merger recipients (team-lead, other devs, …).
# - Per-worktree SHA cache: if a previous run on the same HEAD sha succeeded,
#   skip the chain (instant). The cache is invalidated by every new commit.
# - Otherwise runs (in order): typecheck, prettier, unit-app, unit-functions, e2e.
# - First failure → exit 2 with the failing script's stderr passed through.
#
# DRY RUN MODE: VALIDATE_DRY_RUN=1 → all sub-scripts are skipped, exit 0.
#               VALIDATE_DRY_RUN=fail → simulates a failure, exit 2.

set -u

# (A) Only gate when a developer-* agent is the caller. The orchestrator also
# sends to merger (bare name) — without this check, its shutdown batch and
# merge-forward messages get fully validated, wasting ~60s each.
case "${CLAUDE_AGENT_NAME:-}" in
  developer-*)
    : # gate applies
    ;;
  *)
    exit 0
    ;;
esac

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
if [ -z "$STDIN" ]; then
  exit 0
fi

# Parse the recipient from JSON via node (always available — project runs on it).
if command -v node >/dev/null 2>&1; then
  TO=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  process.stdout.write((i.tool_input && i.tool_input.to) || "");
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")
else
  # Crude fallback: extract "to":"..." value
  TO=$(echo "$STDIN" | grep -oE '"to"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"to"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi

case "$TO" in
  quality-reviewer-*|test-validator-*|merger-*|merger|quality-reviewer@*|test-validator@*|merger@*)
    : # gate enabled
    ;;
  *)
    exit 0
    ;;
esac

# (B) Skip validation for shutdown_request messages — teardown messages
# carry no diff to validate, and running all 5 scripts per shutdown (up to
# 14 in one batch) wastes ~60s with 0 benefit.
MSG_BODY=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const m = (i.tool_input && i.tool_input.message) || "";
  process.stdout.write(typeof m === "string" ? m : JSON.stringify(m));
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")
if echo "$MSG_BODY" | grep -q "shutdown_request"; then
  exit 0
fi

# Derive the caller's worktree so chained scripts validate only that one.
# Cross-worktree validation made one dev's broken tests block all parallel
# devs' SendMessages — see chronology of session 1055d1b5… for the exact
# failure mode (5 unit-app fails on TASK-006 froze TASK-007 and TASK-008).
#
# Source of truth, in order:
#  1. Suffix on the recipient name (most reviewers/validators)
#  2. TASK-XXX in the message body (for to=merger which has no suffix)
TASK_ID=$(echo "$TO" | grep -oE 'TASK-[0-9]+' | head -1)
if [ -z "$TASK_ID" ]; then
  TASK_ID=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const msg = (i.tool_input && i.tool_input.message) || "";
  const text = typeof msg === "string" ? msg : JSON.stringify(msg);
  const m = text.match(/TASK-[0-9]+/);
  process.stdout.write(m ? m[0] : "");
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")
fi

if [ -n "$TASK_ID" ]; then
  # The chained scripts re-check that this dir exists before using it; if the
  # worktree has been removed (e.g. post-merge), they fall back to scanning
  # all active worktrees, which will be a no-op when none remain.
  export VALIDATE_WORKTREE="/app/worktrees/$TASK_ID"
fi

# (F) Enforce that the developer notifies BOTH reviewers before reaching the
# merger. Flags are written at the end of this hook on successful validation
# for quality-reviewer-* and test-validator-* destinations.
if [ -n "$TASK_ID" ]; then
  case "$TO" in
    merger|merger-*)
      MISSING=""
      [ ! -f "/tmp/notified-qr-$TASK_ID" ] && MISSING="${MISSING}quality-reviewer-$TASK_ID "
      [ ! -f "/tmp/notified-tv-$TASK_ID" ] && MISSING="${MISSING}test-validator-$TASK_ID "
      if [ -n "$MISSING" ]; then
        echo "[validate-before-review] Blocked: cannot message merger for $TASK_ID before notifying all reviewers. Missing: $MISSING" >&2
        echo "Send \"ready, please review\" to both quality-reviewer-$TASK_ID AND test-validator-$TASK_ID first." >&2
        exit 2
      fi
      ;;
  esac
fi

echo "[$(date -Iseconds)] validate-before-review START to=$TO worktree=${VALIDATE_WORKTREE:-<all>}" >> "$LOG" 2>/dev/null || true

# SHA cache: skip the validation chain if HEAD of any active worktree matches
# the SHA we last validated successfully. The cache invalidates as soon as the
# dev makes a new commit. One file per worktree under /tmp (overlay, ephemeral,
# perfect for a per-container cache).
ACTIVE_WORKTREES=$(git -C /app worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{print $2}' \
  | grep "^/app/worktrees/" || true)

# (C) Scope the SHA cache to the specific worktree when VALIDATE_WORKTREE is
# set. Using ALL active worktrees caused spurious cache misses: an unrelated
# worktree committing invalidated the cache for the current one, triggering a
# full 60s re-validation even though nothing changed for this task.
CACHE_WORKTREES="${VALIDATE_WORKTREE:-}"
if [ -z "$CACHE_WORKTREES" ]; then
  CACHE_WORKTREES="$ACTIVE_WORKTREES"
fi

if [ -n "$CACHE_WORKTREES" ]; then
  ALL_CACHED=1
  for WT in $CACHE_WORKTREES; do
    HEAD_SHA=$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo "")
    if [ -z "$HEAD_SHA" ]; then ALL_CACHED=0; break; fi
    CACHE_FILE="/tmp/validate-cache-$(echo "$WT" | tr '/' '_').sha"
    LAST_SHA=$(cat "$CACHE_FILE" 2>/dev/null || echo "")
    if [ "$HEAD_SHA" != "$LAST_SHA" ]; then ALL_CACHED=0; break; fi
  done
  if [ "$ALL_CACHED" = "1" ]; then
    echo "[$(date -Iseconds)] validate-before-review CACHE HIT to=$TO (worktree at last-validated SHA)" >> "$LOG" 2>/dev/null || true
    exit 0
  fi
fi

# Dry-run hooks (test-only)
case "${VALIDATE_DRY_RUN:-}" in
  1)
    # Echo the extracted worktree on stderr so tests can verify the parse.
    echo "VALIDATE_WORKTREE=${VALIDATE_WORKTREE:-<all>}" >&2
    echo "[$(date -Iseconds)] validate-before-review DRY_RUN=1, skipping checks, exit 0" >> "$LOG" 2>/dev/null || true
    exit 0
    ;;
  fail)
    echo "[$(date -Iseconds)] validate-before-review DRY_RUN=fail, exit 2" >> "$LOG" 2>/dev/null || true
    echo "Validation failed (simulated)." >&2
    exit 2
    ;;
esac

HOOK_DIR="$(dirname "$0")"

# Ordered list: cheapest checks first to fail fast.
SCRIPTS=(
  typecheck-on-commit.sh
  prettier-on-stop.sh
  run-unit-tests-app.sh
  run-unit-tests-functions.sh
  run-e2e-tests.sh
)

for script in "${SCRIPTS[@]}"; do
  full="$HOOK_DIR/$script"
  if [ ! -x "$full" ]; then
    echo "[$(date -Iseconds)] validate-before-review WARN $script missing or not executable, skipping" >> "$LOG" 2>/dev/null || true
    continue
  fi
  # Pipe an empty SubagentStop-like stdin so the existing scripts don't error on cat.
  EMPTY_STDIN='{"hook_event_name":"PreToolUse_SendMessage","matcher":"SendMessage"}'
  if echo "$EMPTY_STDIN" | "$full" >/tmp/validate-stderr-$$.log 2>&1; then
    echo "[$(date -Iseconds)] validate-before-review $script OK" >> "$LOG" 2>/dev/null || true
  else
    EXIT=$?
    echo "[$(date -Iseconds)] validate-before-review $script FAILED exit=$EXIT" >> "$LOG" 2>/dev/null || true
    cat /tmp/validate-stderr-$$.log >&2
    rm -f /tmp/validate-stderr-$$.log
    exit 2
  fi
  rm -f /tmp/validate-stderr-$$.log
done

echo "[$(date -Iseconds)] validate-before-review ALL OK to=$TO" >> "$LOG" 2>/dev/null || true

# Cache the SHA(s) we just validated so subsequent SendMessages on the same
# commit can short-circuit instantly. Scoped to CACHE_WORKTREES (= specific
# worktree when VALIDATE_WORKTREE is set, all active worktrees otherwise).
if [ -n "$CACHE_WORKTREES" ]; then
  for WT in $CACHE_WORKTREES; do
    HEAD_SHA=$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$HEAD_SHA" ]; then
      CACHE_FILE="/tmp/validate-cache-$(echo "$WT" | tr '/' '_').sha"
      printf '%s' "$HEAD_SHA" > "$CACHE_FILE"
    fi
  done
fi

# (F) Record that this reviewer/validator/merger was successfully notified for TASK_ID.
# member-idle-gate reads these flags to unblock each agent type.
if [ -n "$TASK_ID" ]; then
  case "$TO" in
    quality-reviewer-*)
      touch "/tmp/notified-qr-$TASK_ID" 2>/dev/null || true
      ;;
    test-validator-*)
      touch "/tmp/notified-tv-$TASK_ID" 2>/dev/null || true
      ;;
    merger|merger-*)
      touch "/tmp/notified-merger-$TASK_ID" 2>/dev/null || true
      ;;
  esac
fi

exit 0
