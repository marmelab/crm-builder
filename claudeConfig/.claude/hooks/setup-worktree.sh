#!/bin/bash
# SubagentStart hook — creates the git worktree + hard-links node_modules.
# Triggered for developer and simple-developer agents.
#
# Identity logic (no stdin parsing needed):
#   CLAUDE_AGENT_NAME contains TASK-XXX  → COMPLEX developer
#   CLAUDE_AGENT_NAME empty / no TASK    → SIMPLE (simple-developer, no explicit name)
#
# COMPLEX (developer-TASK-XXX):
#   WORKTREE_PATH = /app/worktrees/<SESSION_SHORT>/<TASK_ID>
#   BRANCH_NAME   = <SESSION_SHORT>/<TASK_ID>
#
# SIMPLE (simple-developer):
#   WORKTREE_PATH = /app/worktrees/<SESSION_SHORT>/simple
#   BRANCH_NAME   = <SESSION_SHORT>/simple
#
# Recovery:
#   1. Already registered in git   → skip (restart scenario)
#   2. Orphan dir, not registered  → rm -rf, then retry
#   3. Orphan branch, no worktree  → force-delete branch so -b works

set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
if [ -z "$SESSION_SHORT" ]; then
  echo "[$(date -Iseconds)] setup-worktree SKIP no SESSION_SHORT" >> "$LOG" 2>/dev/null || true
  exit 0
fi

APP_DIR=${APP_DIR:-/app}
BASE=$(git -C "$APP_DIR" symbolic-ref --short HEAD 2>/dev/null || echo main)

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
# add silently failed (2>/dev/null) and retried every SubagentStart forever.
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

STDIN=$(cat)
AGENT_TYPE=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.agent_type||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")

# Primary: extract TASK_ID from the prompt field (new no-team dispatch: "TASK_ID: TASK-XXX")
TASK_ID=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");const m=(i.prompt||"").match(/TASK_ID:\s*(TASK-\d+)/);process.stdout.write(m?m[1]:"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")

# Fallback: old team dispatch had agent_type=developer-TASK-XXX
if [ -z "$TASK_ID" ]; then
  TASK_ID=$(echo "$AGENT_TYPE" | grep -oE 'TASK-[0-9]+' || echo "")
fi

# Derive WORKTREE_PATH and BRANCH_NAME: prefer values from prompt if present
WORKTREE_PATH=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");const m=(i.prompt||"").match(/WORKTREE_PATH:\s*(\S+)/);process.stdout.write(m?m[1]:"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
BRANCH_NAME=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");const m=(i.prompt||"").match(/BRANCH_NAME:\s*(\S+)/);process.stdout.write(m?m[1]:"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")

if [ -n "$TASK_ID" ]; then
  [ -z "$WORKTREE_PATH" ] && WORKTREE_PATH="${APP_DIR}/worktrees/${SESSION_SHORT}/${TASK_ID}"
  [ -z "$BRANCH_NAME" ] && BRANCH_NAME="${SESSION_SHORT}/${TASK_ID}"
elif [ "$AGENT_TYPE" = "simple-developer" ]; then
  WORKTREE_PATH="${APP_DIR}/worktrees/${SESSION_SHORT}/simple"
  BRANCH_NAME="${SESSION_SHORT}/simple"
else
  echo "[$(date -Iseconds)] setup-worktree SKIP unknown agent_type=$AGENT_TYPE" >> "$LOG" 2>/dev/null || true
  exit 0
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

# Hard-link node_modules (zero disk cost, keeps vitest cache valid)
if [ ! -e "$WORKTREE_PATH/node_modules" ]; then
  cp -al "${APP_DIR}/node_modules" "$WORKTREE_PATH/node_modules"
  echo "[$(date -Iseconds)] setup-worktree node_modules hard-linked" >> "$LOG" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] setup-worktree OK wt=$WORKTREE_PATH" >> "$LOG" 2>/dev/null || true
exit 0
