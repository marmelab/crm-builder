#!/bin/bash
# wait-for-team-merges.sh — block (up to 60s) waiting for new merger reports
# in the team-lead inbox. Used by the chat-orchestrator to "hold" its turn
# during a COMPLEX wave: instead of yielding end_turn after dispatching the
# team (which lets the runtime tear down in-process teammates mid-flight),
# the orchestrator loops Bash() on this script and stays continuously busy
# until every merger report has arrived.
#
# Args:
#   $1 = expected total merger reports (integer, required)
#   $2 = last_count — number of reports the orchestrator has already seen
#        (defaults to 0). Used to compute new_reports without state on disk.
#   $3 = team name (defaults to "tickets")
#
# Output (always on stdout, single line JSON):
#   {"count_received": N, "count_expected": M, "done": bool,
#    "new_reports": [<text>, ...], "timeout": bool}
#
# Always exits 0 — the orchestrator decides what to do based on the JSON.
# This avoids the Bash-tool's stderr-on-non-zero pollution making the
# transcript noisier than it has to be.

set -u

EXPECTED="${1:?expected count required}"
LAST_COUNT="${2:-0}"
TEAM="${3:-tickets}"
INBOX="${HOME:-/home/developer}/.claude/teams/$TEAM/inboxes/team-lead.json"

# Total wall-clock budget. 60s keeps the Bash tool well under its 120s default
# timeout and gives the orchestrator a chance to emit a status update to the
# user every minute even when nothing's happening.
DEADLINE=$(($(date +%s) + 60))

# Read the inbox and return a JSON array of merger report texts in order.
# Returns "[]" if the inbox is missing or malformed.
all_reports() {
  if [ ! -f "$INBOX" ]; then
    echo "[]"
    return
  fi
  node -e '
    try {
      const fs = require("fs");
      const inbox = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]");
      const out = [];
      for (const e of (Array.isArray(inbox) ? inbox : [])) {
        if ((e.from || "") !== "merger") continue;
        const t = (e.text || e.message || "").toString();
        if (/merged\s+TASK-|merge\s+failed/i.test(t)) out.push(t);
      }
      process.stdout.write(JSON.stringify(out));
    } catch { process.stdout.write("[]"); }
  ' "$INBOX" 2>/dev/null || echo "[]"
}

emit() {
  local all_json="$1"
  local timeout_flag="$2"
  local count new_reports done_flag
  count=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(0)).length))}catch{process.stdout.write("0")}' <<<"$all_json" 2>/dev/null || echo "0")
  new_reports=$(node -e '
    const all = JSON.parse(process.argv[1] || "[]");
    const last = parseInt(process.argv[2] || "0", 10);
    process.stdout.write(JSON.stringify(all.slice(Math.max(0, last))));
  ' "$all_json" "$LAST_COUNT" 2>/dev/null || echo "[]")
  done_flag=$([ "$count" -ge "$EXPECTED" ] && echo true || echo false)
  printf '{"count_received":%d,"count_expected":%d,"done":%s,"new_reports":%s,"timeout":%s}\n' \
    "$count" "$EXPECTED" "$done_flag" "$new_reports" "$timeout_flag"
}

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ALL=$(all_reports)
  CURRENT=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(0)).length))}catch{process.stdout.write("0")}' <<<"$ALL" 2>/dev/null || echo "0")
  # Return as soon as anything new is observable to the orchestrator. Returning
  # early on any progress lets the orchestrator emit an incremental status
  # update to the user; returning early on `done` skips needless polling once
  # all merges are in.
  if [ "$CURRENT" -gt "$LAST_COUNT" ] || [ "$CURRENT" -ge "$EXPECTED" ]; then
    emit "$ALL" false
    exit 0
  fi
  sleep 2
done

# Deadline reached without progress — emit current state with timeout=true so
# the orchestrator can decide whether to retry or report stalled.
ALL=$(all_reports)
emit "$ALL" true
exit 0
