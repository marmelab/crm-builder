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
#   BRANCH_NAME   = simple/<SESSION_SHORT>
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

STDIN=$(cat)
# agent_type in SubagentStart stdin contains the full agent name (e.g. developer-TASK-001)
AGENT_TYPE=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.agent_type||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
TASK_ID=$(echo "$AGENT_TYPE" | grep -oE 'TASK-[0-9]+' || echo "")

if [ -n "$TASK_ID" ]; then
  WORKTREE_PATH="/app/worktrees/${SESSION_SHORT}/${TASK_ID}"
  BRANCH_NAME="${SESSION_SHORT}/${TASK_ID}"
elif [ "$AGENT_TYPE" = "simple-developer" ]; then
  WORKTREE_PATH="/app/worktrees/${SESSION_SHORT}/simple"
  BRANCH_NAME="simple/${SESSION_SHORT}"
else
  echo "[$(date -Iseconds)] setup-worktree SKIP unknown agent_type=$AGENT_TYPE" >> "$LOG" 2>/dev/null || true
  exit 0
fi

echo "[$(date -Iseconds)] setup-worktree START agent=$AGENT_TYPE path=$WORKTREE_PATH branch=$BRANCH_NAME" >> "$LOG" 2>/dev/null || true

# Recovery 1: already registered → restart, use as-is
if git -C /app worktree list --porcelain 2>/dev/null | grep -qF "worktree $WORKTREE_PATH"; then
  echo "[$(date -Iseconds)] setup-worktree SKIP already registered ($WORKTREE_PATH)" >> "$LOG" 2>/dev/null || true
  exit 0
fi

# Recovery 2: orphan dir → clean slate
if [ -d "$WORKTREE_PATH" ]; then
  rm -rf "$WORKTREE_PATH"
  echo "[$(date -Iseconds)] setup-worktree REMOVED orphan dir $WORKTREE_PATH" >> "$LOG" 2>/dev/null || true
fi

mkdir -p "$(dirname "$WORKTREE_PATH")"

# Recovery 3: orphan branch → force-delete so -b works cleanly
if git -C /app branch --list "$BRANCH_NAME" 2>/dev/null | grep -q .; then
  git -C /app branch -D "$BRANCH_NAME" 2>/dev/null || true
  echo "[$(date -Iseconds)] setup-worktree DELETED orphan branch $BRANCH_NAME" >> "$LOG" 2>/dev/null || true
fi

if git -C /app worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" HEAD 2>/tmp/wt-err; then
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
  cp -al /app/node_modules "$WORKTREE_PATH/node_modules"
  echo "[$(date -Iseconds)] setup-worktree node_modules hard-linked" >> "$LOG" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] setup-worktree OK wt=$WORKTREE_PATH" >> "$LOG" 2>/dev/null || true
exit 0
