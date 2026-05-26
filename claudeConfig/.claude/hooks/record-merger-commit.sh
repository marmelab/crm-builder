#!/bin/bash
# PostToolUse hook on Bash — records the merger's just-completed merge in the
# session's meta.json so the UI's "Undo" can revert it later.
#
# Fires after EVERY Bash call (any agent). Multiple filters narrow down to a
# real merge commit landing on /app's base branch:
#   1. agent_type == "merger"
#   2. command pipeline contains `cd /app && … git merge --no-ff`
#      (NOT `cd /app/worktrees/…` — that's a worktree-local merge, not a
#       merge onto /app/main; we observed this exact failure mode in a real
#       session where the merger merged a branch into itself in the worktree,
#       producing "Already up to date" and never touching main)
#   3. tool_response shows "Merge made by" in stdout
#      (defends against fast-forwards and no-ops; in either case the merge
#       didn't produce a new merge commit)
#   4. /app HEAD is currently a merge commit (≥2 parents)
#
# The server-side addCommit dedups by SHA, but each guard above also prevents
# us from POSTing a stale /app HEAD that has nothing to do with this Bash call.

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
AGENT_TYPE=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.agent_type||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
[ "$AGENT_TYPE" != "merger" ] && exit 0

COMMAND=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.tool_input?.command||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
case "$COMMAND" in
  *"cd /app/worktrees/"*"git merge"*)
    echo "[$(date -Iseconds)] record-merger-commit SKIP merge_in_worktree cmd=${COMMAND:0:120}" >> "$LOG" 2>/dev/null || true
    exit 0
    ;;
  *"cd /app"*"git merge --no-ff"*) ;;
  *"git merge --no-ff"*)
    # Allow if no explicit cd at all (relies on default cwd /app). Still log
    # so we can audit if this ever fires unexpectedly.
    case "$COMMAND" in
      *"cd "*) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac

# Confirm the merge produced a real commit (not fast-forward, not no-op).
# tool_response can be at top-level or nested; check both shapes.
MERGE_OUTPUT=$(node -e '
  try {
    const i = JSON.parse(process.argv[1] || "{}");
    const r = i.tool_response || i.tool_result || {};
    const stdout = r.stdout || r.output || (typeof r === "string" ? r : "");
    const content = Array.isArray(r.content) ? r.content.map(c => c.text || "").join("\n") : "";
    process.stdout.write(stdout + "\n" + content);
  } catch {}
' "$STDIN" 2>/dev/null || echo "")

case "$MERGE_OUTPUT" in
  *"Merge made by"*) ;;
  *)
    echo "[$(date -Iseconds)] record-merger-commit SKIP no_merge_made_marker out=${MERGE_OUTPUT:0:160}" >> "$LOG" 2>/dev/null || true
    exit 0
    ;;
esac

# Parent count — HEAD must be a merge commit (≥2 parents) for the recording
# to make sense.
PARENTS=$(git -C /app log -1 --format=%P 2>/dev/null)
NUM_PARENTS=$(echo "$PARENTS" | wc -w)
if [ "$NUM_PARENTS" -lt 2 ]; then
  echo "[$(date -Iseconds)] record-merger-commit SKIP head_not_merge num_parents=$NUM_PARENTS" >> "$LOG" 2>/dev/null || true
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
