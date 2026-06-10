#!/bin/bash
# PreToolUse/Agent hook — creates the git worktree + hard-links node_modules
# for a developer / simple-developer dispatch, BEFORE the subagent starts.
#
# WHY PreToolUse and not SubagentStart:
#   The SubagentStart payload carries only `agent_type` ("developer") and an
#   opaque `agent_id` hash — NOT the dispatch `name` ("developer-TASK-002"),
#   NOT the prompt, and (for parallel waves) no way to tell which of the N
#   simultaneously-starting developers is which. So a SubagentStart hook
#   cannot know the TASK_ID / worktree path of the agent that is starting, and
#   every COMPLEX dev fell through to "SKIP unknown agent_type=developer" — the
#   worktree was never created and the developer had to improvise one by hand
#   (off-convention, extra turns/cost).
#
#   The PreToolUse/Agent hook fires on the ORCHESTRATOR's dispatch instead, and
#   there `tool_input.prompt` carries the canonical identity the STATE B
#   template always sets:  TASK_ID, WORKTREE_PATH, BRANCH_NAME. One Agent call =
#   one ticket, so there is no parallel-dispatch ambiguity. enforce-dev-dispatch
#   guarantees WORKTREE_PATH is present, so the convention stays uniform — the
#   worktree is always created the same way, centrally, never by the developer.
#
# Identity (from tool_input.prompt of the dispatch):
#   COMPLEX developer:        WORKTREE_PATH=/app/worktrees/<SHORT>/<TASK_ID>   BRANCH_NAME=<SHORT>/<branch>
#   SIMPLE simple-developer:  WORKTREE_PATH=/app/worktrees/<SHORT>/simple      BRANCH_NAME=<SHORT>/simple
#
# Recovery:
#   1. Already registered in git   → skip (restart / retry scenario)
#   2. Orphan dir, not registered  → rm -rf, then retry
#   3. Orphan branch, no worktree  → force-delete branch so -b works

set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)

# PreToolUse/Agent schema: { tool_input: { subagent_type, prompt, ... } }.
# Extract the dispatched type and the identity fields from the prompt in one
# node pass. enforce-dev-dispatch already blocks developer dispatches missing
# WORKTREE_PATH, so it is reliably present here for both dev variants.
INFO=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const t = i.tool_input || {};
  const st = t.subagent_type || "";
  const pr = t.prompt || "";
  const wt = (pr.match(/WORKTREE_PATH:\s*(\S+)/) || [])[1] || "";
  const br = (pr.match(/BRANCH_NAME:\s*(\S+)/) || [])[1] || "";
  const tk = (pr.match(/TASK_ID:\s*(TASK-\d+)/) || [])[1] || "";
  process.stdout.write([st, wt, br, tk].join("|"));
} catch (e) { process.stdout.write("|||"); }
' "$STDIN" 2>/dev/null || echo "|||")

AGENT_TYPE="${INFO%%|*}"; REST="${INFO#*|}"
WORKTREE_PATH="${REST%%|*}"; REST="${REST#*|}"
BRANCH_NAME="${REST%%|*}"; TASK_ID="${REST##*|}"

# Only act on dev dispatches. Reviewers / mergers / planner / documentator reuse
# (or never touch) a worktree — exit silently so the dispatch proceeds.
case "$AGENT_TYPE" in
  developer|simple-developer) ;;
  *) exit 0 ;;
esac

# Derive the session short id from the worktree path (.../worktrees/<SHORT>/...),
# falling back to CHAT_SESSION_DIR. The path is authoritative because it is the
# exact value the worktree will live at.
SESSION_SHORT=""
if [ -n "$WORKTREE_PATH" ]; then
  SESSION_SHORT=$(printf '%s\n' "$WORKTREE_PATH" | sed -nE 's#.*/worktrees/([^/]+)/.*#\1#p')
fi
[ -z "$SESSION_SHORT" ] && SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)

# SIMPLE flow parity: a simple-developer always works in the fixed
# <SHORT>/simple worktree. The orchestrator's templates pass WORKTREE_PATH, but
# derive it from SESSION_SHORT as a fallback so the SIMPLE path never depends on
# the prompt carrying it (matches the previous SubagentStart behaviour).
if [ -z "$WORKTREE_PATH" ] && [ "$AGENT_TYPE" = "simple-developer" ] && [ -n "$SESSION_SHORT" ]; then
  WORKTREE_PATH="${APP_DIR:-/app}/worktrees/${SESSION_SHORT}/simple"
  [ -z "$BRANCH_NAME" ] && BRANCH_NAME="${SESSION_SHORT}/simple"
fi

if [ -z "$SESSION_SHORT" ] || [ -z "$WORKTREE_PATH" ]; then
  echo "[$(date -Iseconds)] setup-worktree SKIP missing identity agent_type=$AGENT_TYPE wt=$WORKTREE_PATH short=$SESSION_SHORT" >> "$LOG" 2>/dev/null || true
  exit 0
fi

# BRANCH_NAME is normally provided; derive a sensible default if a caller omitted it.
[ -z "$BRANCH_NAME" ] && BRANCH_NAME="${SESSION_SHORT}/${TASK_ID:-simple}"

APP_DIR=${APP_DIR:-/app}
BASE=$(git -C "$APP_DIR" symbolic-ref --short HEAD 2>/dev/null || echo main)

# Serialise the whole git-mutation region per session. A COMPLEX wave dispatches
# N developers in ONE orchestrator message, so N PreToolUse hooks fire nearly
# simultaneously; without a lock they would race on session/<SHORT> creation,
# the single `_session` worktree, and git's internal worktree/config locks
# during concurrent `git worktree add`. The fd is held until this process
# exits (flock releases on close), so the `exit` statements below work normally.
exec 9>"/tmp/setup-wt-${SESSION_SHORT}.lock"
flock 9 2>/dev/null || true

# Create the per-session integration branch, its fixed fork anchor, and the
# integration worktree. The anchor ref never moves and is the stable diff
# baseline for migrations (later phase). Branch creation and worktree creation
# are guarded independently so a partial failure retries on the next invocation.
SESSION_WT="${APP_DIR}/worktrees/${SESSION_SHORT}/_session"
if ! git -C "$APP_DIR" show-ref --verify --quiet "refs/heads/session/${SESSION_SHORT}"; then
  git -C "$APP_DIR" branch "session/${SESSION_SHORT}"      "$BASE" 2>/dev/null || true
  git -C "$APP_DIR" branch "session-base/${SESSION_SHORT}" "$BASE" 2>/dev/null || true
fi
# A live git worktree owns a `.git` file pointing at its gitdir. Test that,
# not mere dir presence: on a session restart the bind-mount/cleanup can wipe
# the directory while git still holds the registration, and `git worktree add`
# then refuses with "missing but already registered worktree". The TASK block
# below has explicit recovery; the _session block historically had none, so the
# add silently failed (2>/dev/null) and retried every dispatch forever.
if [ ! -e "$SESSION_WT/.git" ]; then
  rm -rf "$SESSION_WT" 2>/dev/null || true          # clear orphan dir (no .git)
  mkdir -p "$(dirname "$SESSION_WT")"
  git -C "$APP_DIR" worktree prune 2>/dev/null || true   # drop stale registrations
  if git -C "$APP_DIR" worktree add "$SESSION_WT" "session/${SESSION_SHORT}" 2>/tmp/session-wt-err; then
    [ -e "$SESSION_WT/node_modules" ] || cp -al "${APP_DIR}/node_modules" "$SESSION_WT/node_modules" 2>/dev/null || true
    echo "[$(date -Iseconds)] setup-worktree SESSION-BRANCH created session/${SESSION_SHORT} from $BASE" >> "$LOG" 2>/dev/null || true
  else
    echo "[$(date -Iseconds)] setup-worktree SESSION-BRANCH FAILED _session worktree session/${SESSION_SHORT} err=$(tr '\n' ' ' </tmp/session-wt-err 2>/dev/null)" >> "$LOG" 2>/dev/null || true
  fi
fi

# A (re)starting developer means the diff will change — invalidate any prior
# review verdicts for this ticket so stale APPROVED flags can't let the merger
# through before the new attempt is re-reviewed (see record-review-verdict.sh /
# block-merger-without-review.sh).
if [ -n "$TASK_ID" ]; then
  rm -f "/tmp/review-${SESSION_SHORT}-${TASK_ID}-quality-reviewer" \
        "/tmp/review-${SESSION_SHORT}-${TASK_ID}-test-validator" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] setup-worktree START agent=$AGENT_TYPE path=$WORKTREE_PATH branch=$BRANCH_NAME" >> "$LOG" 2>/dev/null || true

# Recovery 1: already registered → restart, use as-is
if git -C "$APP_DIR" worktree list --porcelain 2>/dev/null | grep -qF "worktree $WORKTREE_PATH"; then
  echo "[$(date -Iseconds)] setup-worktree SKIP already registered ($WORKTREE_PATH)" >> "$LOG" 2>/dev/null || true
  exit 0
fi

# Never targets _session (different path; created in the session-branch block above).
# Recovery 2: orphan dir → clean slate
if [ -d "$WORKTREE_PATH" ]; then
  rm -rf "$WORKTREE_PATH"
  echo "[$(date -Iseconds)] setup-worktree REMOVED orphan dir $WORKTREE_PATH" >> "$LOG" 2>/dev/null || true
fi

mkdir -p "$(dirname "$WORKTREE_PATH")"

# Recovery 3: orphan branch → force-delete so -b works cleanly
if git -C "$APP_DIR" branch --list "$BRANCH_NAME" 2>/dev/null | grep -q .; then
  git -C "$APP_DIR" branch -D "$BRANCH_NAME" 2>/dev/null || true
  echo "[$(date -Iseconds)] setup-worktree DELETED orphan branch $BRANCH_NAME" >> "$LOG" 2>/dev/null || true
fi

if git -C "$APP_DIR" worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "session/${SESSION_SHORT}" 2>/tmp/wt-err; then
  echo "[$(date -Iseconds)] setup-worktree CREATED branch=$BRANCH_NAME path=$WORKTREE_PATH" >> "$LOG" 2>/dev/null || true
else
  ERR=$(cat /tmp/wt-err 2>/dev/null)
  echo "[$(date -Iseconds)] setup-worktree EXIT=2 path=$WORKTREE_PATH err=$ERR" >> "$LOG" 2>/dev/null || true
  cat >&2 <<EOF
[setup-worktree] Cannot create worktree at $WORKTREE_PATH (branch=$BRANCH_NAME): $ERR
EOF
  exit 2
fi

# Hard-link node_modules (zero disk cost)
if [ ! -e "$WORKTREE_PATH/node_modules" ]; then
  cp -al "${APP_DIR}/node_modules" "$WORKTREE_PATH/node_modules"
  echo "[$(date -Iseconds)] setup-worktree node_modules hard-linked" >> "$LOG" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] setup-worktree OK wt=$WORKTREE_PATH" >> "$LOG" 2>/dev/null || true
exit 0
