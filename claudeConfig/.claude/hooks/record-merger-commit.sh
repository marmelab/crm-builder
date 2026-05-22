#!/bin/bash
# SubagentStop hook (matcher: merger) — records the just-produced merge SHA
# in the session's meta.json so the UI's "Undo" can revert it later.
#
# The merger's final output is either:
#   - SIMPLE  : "DONE: commit=<short SHA>. files=[...]"
#   - COMPLEX : SendMessage(team-lead, "merged TASK-XXX, commit=<short SHA>")
# Both carry the same `commit=<sha>` substring. We try the hook's
# `transcript_path` first; on miss we fall back to scanning the live Claude
# CLI subagents dir for the most-recently-touched agent-*.jsonl that contains
# our marker — which catches the case where Claude Code passes the parent
# orchestrator's transcript (which hasn't seen the subagent's reply yet at
# SubagentStop fire time).
#
# Best-effort: never fails the agent. addCommit dedups on the server side.

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
TRANSCRIPT_PATH=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.transcript_path||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")
CLAUDE_SESSION_ID=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.session_id||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")

extract_sha() {
  local path="$1"
  [ -n "$path" ] && [ -f "$path" ] || { echo ""; return; }
  grep -oE 'commit=[a-f0-9]{7,40}' "$path" 2>/dev/null | tail -1 | sed 's/^commit=//'
}

# 1. Primary: the path the hook was given.
SHA=$(extract_sha "$TRANSCRIPT_PATH")
SOURCE="transcript_path"

# 2. Fallback: scan ~/.claude/projects/-app/<claudeSessionId>/subagents/agent-*.jsonl
# for the most-recently-modified file that contains a commit=<sha> marker.
# This is where Claude Code writes per-subagent transcripts in real time.
if [ -z "$SHA" ] && [ -n "$CLAUDE_SESSION_ID" ]; then
  SUBAGENTS_DIR="${HOME:-/home/developer}/.claude/projects/-app/${CLAUDE_SESSION_ID}/subagents"
  if [ -d "$SUBAGENTS_DIR" ]; then
    for f in $(ls -t "$SUBAGENTS_DIR"/agent-*.jsonl 2>/dev/null); do
      CANDIDATE=$(extract_sha "$f")
      if [ -n "$CANDIDATE" ]; then
        SHA="$CANDIDATE"
        SOURCE="fallback:$(basename "$f")"
        break
      fi
    done
  fi
fi

if [ -z "$SHA" ]; then
  TRANSCRIPT_LINES=$(wc -l < "$TRANSCRIPT_PATH" 2>/dev/null || echo "?")
  TRANSCRIPT_BYTES=$(wc -c < "$TRANSCRIPT_PATH" 2>/dev/null || echo "?")
  STDIN_DUMP=$(echo "$STDIN" | head -c 400 | tr '\n' '|')
  echo "[$(date -Iseconds)] record-merger-commit SKIP no_sha primary=$TRANSCRIPT_PATH lines=$TRANSCRIPT_LINES bytes=$TRANSCRIPT_BYTES claudeSessionId=$CLAUDE_SESSION_ID stdin=$STDIN_DUMP" >> "$LOG" 2>/dev/null || true
  exit 0
fi

SESSION_ID=$(basename "${CHAT_SESSION_DIR:-}")
if [ -z "$SESSION_ID" ]; then
  echo "[$(date -Iseconds)] record-merger-commit SKIP no_session_id sha=$SHA" >> "$LOG" 2>/dev/null || true
  exit 0
fi

curl -fsS -X POST "http://localhost:8080/api/sessions/${SESSION_ID}/commits/${SHA}" >/dev/null 2>&1
RC=$?
echo "[$(date -Iseconds)] record-merger-commit POST sha=${SHA} session=${SESSION_ID} source=${SOURCE} rc=${RC}" >> "$LOG" 2>/dev/null || true
exit 0
