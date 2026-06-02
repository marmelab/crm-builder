#!/bin/bash
# SubagentStop hook for quality-reviewer / test-validator (no-team flow).
#
# Records each reviewer's verdict as a per-ticket flag so the merger gate
# (block-merger-without-review.sh) can enforce dev -> reviewers -> merger.
# SubagentStop cannot block — it only records.
#
# Flag layout (presence == APPROVED):
#   /tmp/review-<SESSION_SHORT>-<TASK>-<role>
# Cleared on REJECTED here, and when a developer (re)starts the ticket
# (setup-worktree.sh) so a changed diff invalidates stale approvals.
#
# Verdict + ticket are read from the subagent's own transcript (transcript_path):
# the reviewer's OUTPUT CONTRACT is a final line of exactly `APPROVED` or
# `REJECTED: ...`; the spawn prompt carries `TASK_ID: TASK-XXX` / WORKTREE_PATH.
set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
[ -z "$SESSION_SHORT" ] && exit 0

STDIN=$(cat)

OUT=$(node -e '
try {
  const fs = require("fs");
  const i = JSON.parse(process.argv[1] || "{}");
  const at = i.agent_type || "";
  let role = (at.match(/quality-reviewer|test-validator/) || [""])[0];
  let task = (at.match(/TASK-\d+/) || [""])[0];
  let verdict = "";
  const tp = i.transcript_path || "";
  if (tp && fs.existsSync(tp)) {
    let lastText = "";
    for (const ln of fs.readFileSync(tp, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      let e; try { e = JSON.parse(ln); } catch { continue; }
      const msg = e.message || e;
      const content = msg && msg.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) lastText = b.text;
        }
      } else if (typeof content === "string" && content.trim()) {
        lastText = content;
      }
      if (!task) { const m = ln.match(/TASK-\d+/); if (m) task = m[0]; }
    }
    const tail = (lastText.trim().split("\n").map(s => s.trim()).filter(Boolean).pop() || "");
    if (/^APPROVED\b/.test(tail)) verdict = "APPROVED";
    else if (/^REJECTED\b/.test(tail)) verdict = "REJECTED";
  }
  process.stdout.write([role, task, verdict].join("|"));
} catch (e) { process.stdout.write("||"); }
' "$STDIN" 2>/dev/null || echo "||")

ROLE="${OUT%%|*}"; REST="${OUT#*|}"; TASK="${REST%%|*}"; VERDICT="${REST##*|}"

[ -z "$ROLE" ] && exit 0
if [ -z "$TASK" ]; then
  echo "[$(date -Iseconds)] record-review SKIP no-task role=$ROLE verdict=${VERDICT:-?}" >> "$LOG" 2>/dev/null || true
  exit 0
fi

FLAG="/tmp/review-${SESSION_SHORT}-${TASK}-${ROLE}"
if [ "$VERDICT" = "APPROVED" ]; then
  : > "$FLAG"
  echo "[$(date -Iseconds)] record-review APPROVED $TASK $ROLE" >> "$LOG" 2>/dev/null || true
else
  rm -f "$FLAG"
  echo "[$(date -Iseconds)] record-review ${VERDICT:-UNKNOWN} (cleared) $TASK $ROLE" >> "$LOG" 2>/dev/null || true
fi
exit 0
