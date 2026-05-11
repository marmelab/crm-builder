#!/bin/bash
# PreToolUse hook for TeamDelete tool.
#
# Two guards, checked in order:
#
# 1. Circuit-breaker: if PostToolUse already flagged that the last TeamDelete
#    found no team ("No team name found, nothing to clean up"), block immediately
#    with a STATE DONE message. This prevents the orchestrator from looping in
#    STATE DONE after all waves are complete.
#    Flag file: /tmp/teamdelete-empty-<session_hash> (written by teamdelete-cleanup.sh)
#    Cleared when a real team deletion succeeds (for multi-wave sessions).
#
# 2. Member shutdown check: blocks TeamDelete if any non-lead member has not
#    been gracefully shut down. Points to the agent-team skill Phase 3 protocol.
#
# Behavior:
#   - exit 0 → allow TeamDelete
#   - exit 2 → block with stderr pointing to the missing step

set -u

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
hook_log() {
  [ -d "$(dirname "$LOG")" ] || return 0
  printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG" 2>/dev/null || true
}

STDIN=$(cat)
[ -z "$STDIN" ] && exit 0

if ! command -v node >/dev/null 2>&1; then
  # Without node we cannot inspect inboxes safely. Let the runtime handle it.
  exit 0
fi

# Parse top-level fields from the STDIN JSON
INPUT_PARSED=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  process.stdout.write(JSON.stringify({
    teamName: (i.tool_input && i.tool_input.team_name) || "",
    sessionId: i.session_id || ""
  }));
} catch { process.stdout.write("{}"); }
' "$STDIN" 2>/dev/null || echo "{}")

TEAM_NAME=$(echo "$INPUT_PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).teamName || "")' 2>/dev/null)
SESSION_ID=$(echo "$INPUT_PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).sessionId || "")' 2>/dev/null)

# Guard 1 — circuit-breaker: block if the previous TeamDelete already found no team.
if [ -n "$SESSION_ID" ]; then
  SESSION_HASH=$(echo -n "$SESSION_ID" | sha1sum | cut -c1-16)
  EMPTY_FLAG="/tmp/teamdelete-empty-${SESSION_HASH}"
  if [ -f "$EMPTY_FLAG" ]; then
    hook_log "teamdelete-gate BLOCK circuit-breaker session_hash=${SESSION_HASH}"
    {
      echo "TeamDelete blocked: the previous call already returned 'no team found'."
      echo "You are in STATE DONE — do not call TeamDelete again."
      echo "The session's work is complete. Report done to the user and stop."
    } >&2
    exit 2
  fi
fi

TEAMS_DIR="${HOME:-/home/developer}/.claude/teams"
[ -d "$TEAMS_DIR" ] || exit 0

# Resolve the team to inspect.
if [ -n "$TEAM_NAME" ]; then
  TEAM_DIR="$TEAMS_DIR/$TEAM_NAME"
else
  # TeamDelete({}) — find the unique team owned by this session.
  matches=$(find "$TEAMS_DIR" -mindepth 2 -maxdepth 2 -name config.json 2>/dev/null | while read -r cfg; do
    LEAD_ID=$(node -e '
try {
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(cfg.leadSessionId || "");
} catch { process.stdout.write(""); }
' "$cfg" 2>/dev/null)
    if [ "$LEAD_ID" = "$SESSION_ID" ]; then
      echo "$cfg"
    fi
  done)
  count=$(printf '%s\n' "$matches" | grep -c . || true)
  # 0 → no team for this session; guard 1 (circuit-breaker) handles the loop
  #     case. Here we just allow — runtime will return "nothing to clean up"
  #     and the PostToolUse hook will set the flag for the NEXT call.
  # 2+ → ambiguous, runtime will respond.
  # 1 → use it.
  if [ "$count" != "1" ]; then exit 0; fi
  TEAM_DIR=$(dirname "$matches")
fi

CONFIG="$TEAM_DIR/config.json"
LEAD_INBOX="$TEAM_DIR/inboxes/team-lead.json"

if [ ! -f "$CONFIG" ]; then exit 0; fi
TEAM=$(basename "$TEAM_DIR")

# Non-lead members (one name per line)
MEMBERS=$(node -e '
try {
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const members = Array.isArray(cfg.members) ? cfg.members : [];
  for (const m of members) {
    if (m && m.agentType !== "team-lead" && m.name) {
      process.stdout.write(m.name + "\n");
    }
  }
} catch {}
' "$CONFIG" 2>/dev/null || echo "")
if [ -z "$MEMBERS" ]; then exit 0; fi

# Lead inbox may not yet exist if no message has reached the lead. Treat as
# "no approvals received" rather than aborting.
INBOX_EXISTS=0
[ -f "$LEAD_INBOX" ] && INBOX_EXISTS=1

PENDING_NO_APPROVAL=()  # No shutdown_approved at all
PENDING_NO_YIELD=()     # shutdown_approved present but read:false

while IFS= read -r m; do
  [ -z "$m" ] && continue
  if [ "$INBOX_EXISTS" = "0" ]; then
    PENDING_NO_APPROVAL+=("$m")
    continue
  fi
  # Returns "0:" if no approvals, otherwise "<count>:<latest_read_bool>"
  RESULT=$(node -e '
try {
  const fs = require("fs");
  const inbox = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]");
  const m = process.argv[2];
  const arr = Array.isArray(inbox) ? inbox : [];
  const matching = arr.filter(e => e && e.from === m && (e.text || "").includes("shutdown_approved"));
  if (matching.length === 0) {
    process.stdout.write("0:");
  } else {
    const latestRead = matching[matching.length - 1].read === true ? "true" : "false";
    process.stdout.write(matching.length + ":" + latestRead);
  }
} catch { process.stdout.write("0:"); }
' "$LEAD_INBOX" "$m" 2>/dev/null || echo "0:")

  COUNT="${RESULT%%:*}"
  LATEST_READ="${RESULT##*:}"

  if [ "$COUNT" = "0" ]; then
    PENDING_NO_APPROVAL+=("$m")
    continue
  fi

  if [ "$LATEST_READ" != "true" ]; then
    PENDING_NO_YIELD+=("$m")
  fi
done <<< "$MEMBERS"

TOTAL=$(( ${#PENDING_NO_APPROVAL[@]} + ${#PENDING_NO_YIELD[@]} ))
if [ "$TOTAL" -eq 0 ]; then
  hook_log "teamdelete-gate ALLOW team=$TEAM"
  exit 0
fi

hook_log "teamdelete-gate BLOCK team=$TEAM no_approval=${PENDING_NO_APPROVAL[*]:-} no_yield=${PENDING_NO_YIELD[*]:-}"

{
  echo "TeamDelete blocked: $TOTAL teammate(s) in team '$TEAM' have not been gracefully shut down."
  echo
  if [ ${#PENDING_NO_APPROVAL[@]} -gt 0 ]; then
    echo "No shutdown_approved received from (Step 3a missing or in flight):"
    for m in "${PENDING_NO_APPROVAL[@]}"; do echo "  - $m"; done
    echo
    echo "Step 3a — Send shutdown_request to each pending member, in ONE assistant message:"
    for m in "${PENDING_NO_APPROVAL[@]}"; do
      echo "  SendMessage({to: \"$m\", message: {\"type\": \"shutdown_request\"}})"
    done
    echo
  fi
  if [ ${#PENDING_NO_YIELD[@]} -gt 0 ]; then
    echo "shutdown_approved present but unread (Step 3b missing):"
    for m in "${PENDING_NO_YIELD[@]}"; do echo "  - $m"; done
    echo
  fi
  echo "Step 3b — Emit a brief assistant text and STOP. Do NOT call any other tool in this turn."
  echo "          Yielding the turn is what lets the runtime deliver shutdown_approved replies."
  echo "Step 3c — On the NEXT turn, the runtime injects <teammate-message> blocks marking"
  echo "          shutdown_approved as read."
  echo "Step 3d — Then retry TeamDelete."
  echo
  echo "DO NOT call TeamDelete again immediately — without yielding it will fail the same way."
} >&2

exit 2
