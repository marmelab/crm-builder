#!/bin/bash
# PostToolUse hook on Bash — records the merger's just-completed merge in the
# session's meta.json so the UI's "Undo" can revert it later.
#
# Fires after EVERY Bash call (any agent). Three filters narrow it to actual
# merger merge commits:
#   1. agent_type == "merger"  (skip everyone else)
#   2. command matches `git merge --no-ff` (skip non-merge bash from merger)
#   3. /app's HEAD is a merge commit (has 2+ parents) — the merge succeeded
#
# The server-side addCommit dedups by SHA so a duplicate POST is a no-op.
# Best-effort: never fails the agent.

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
AGENT_TYPE=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.agent_type||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
[ "$AGENT_TYPE" != "merger" ] && exit 0

COMMAND=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.tool_input?.command||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
case "$COMMAND" in
  *"git merge --no-ff"*) ;;
  *) exit 0 ;;
esac

# Parent count — HEAD has ≥2 parents iff the merge produced a commit.
# Conflict path: merge aborted, HEAD unchanged (1 parent on a normal commit,
# or stays at whatever previous merge produced — dedup handles the latter).
PARENTS=$(git -C /app log -1 --format=%P 2>/dev/null)
NUM_PARENTS=$(echo "$PARENTS" | wc -w)
if [ "$NUM_PARENTS" -lt 2 ]; then
  echo "[$(date -Iseconds)] record-merger-commit SKIP not_a_merge num_parents=$NUM_PARENTS cmd=${COMMAND:0:80}" >> "$LOG" 2>/dev/null || true
  exit 0
fi

SHA=$(git -C /app rev-parse HEAD 2>/dev/null)
SESSION_ID=$(basename "${CHAT_SESSION_DIR:-}")
if [ -z "$SHA" ] || [ -z "$SESSION_ID" ]; then
  echo "[$(date -Iseconds)] record-merger-commit SKIP missing_data sha=$SHA session=$SESSION_ID" >> "$LOG" 2>/dev/null || true
  exit 0
fi

curl -fsS -X POST "http://localhost:8080/api/sessions/${SESSION_ID}/commits/${SHA}" >/dev/null 2>&1
RC=$?
echo "[$(date -Iseconds)] record-merger-commit POST sha=${SHA} session=${SESSION_ID} rc=${RC}" >> "$LOG" 2>/dev/null || true
exit 0
