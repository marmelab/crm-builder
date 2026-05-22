#!/bin/bash
# SubagentStop hook (matcher: merger) — records the just-produced merge SHA
# in the session's meta.json so the UI's "Undo" can revert it later.
#
# The merger's final output is either:
#   - SIMPLE  : "DONE: commit=<short SHA>. files=[...]"
#   - COMPLEX : SendMessage(team-lead, "merged TASK-XXX, commit=<short SHA>")
# Both carry the same `commit=<sha>` substring. We grep the last occurrence
# in the merger's transcript and POST it to the chat-service.
#
# Best-effort: never fails the agent. addCommit dedups, so re-records are
# harmless if this hook ever races with itself or with a manual curl.

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
TRANSCRIPT_PATH=$(node -e 'try{const i=JSON.parse(process.argv[1]||"{}");process.stdout.write(i.transcript_path||"")}catch{process.stdout.write("")}' "$STDIN" 2>/dev/null || echo "")

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  echo "[$(date -Iseconds)] record-merger-commit SKIP no_transcript path=${TRANSCRIPT_PATH:-<empty>}" >> "$LOG" 2>/dev/null || true
  exit 0
fi

# Last `commit=<sha>` in the merger's transcript. Covers both SIMPLE's
# "DONE: commit=..." text and COMPLEX's "merged TASK-XXX, commit=..."
# SendMessage payload — both end up as text in the JSONL.
SHA=$(grep -oE 'commit=[a-f0-9]{7,40}' "$TRANSCRIPT_PATH" | tail -1 | sed 's/^commit=//')
if [ -z "$SHA" ]; then
  TRANSCRIPT_LINES=$(wc -l < "$TRANSCRIPT_PATH" 2>/dev/null || echo "?")
  TRANSCRIPT_BYTES=$(wc -c < "$TRANSCRIPT_PATH" 2>/dev/null || echo "?")
  TAIL=$(tail -c 500 "$TRANSCRIPT_PATH" 2>/dev/null | tr '\n' '|' | head -c 500)
  echo "[$(date -Iseconds)] record-merger-commit SKIP no_commit_in_transcript path=$TRANSCRIPT_PATH lines=$TRANSCRIPT_LINES bytes=$TRANSCRIPT_BYTES tail=$TAIL" >> "$LOG" 2>/dev/null || true
  exit 0
fi

SESSION_ID=$(basename "${CHAT_SESSION_DIR:-}")
if [ -z "$SESSION_ID" ]; then
  echo "[$(date -Iseconds)] record-merger-commit SKIP no_session_id" >> "$LOG" 2>/dev/null || true
  exit 0
fi

curl -fsS -X POST "http://localhost:8080/api/sessions/${SESSION_ID}/commits/${SHA}" >/dev/null 2>&1
RC=$?
echo "[$(date -Iseconds)] record-merger-commit POST sha=${SHA} session=${SESSION_ID} rc=${RC}" >> "$LOG" 2>/dev/null || true
exit 0
