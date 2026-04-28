#!/bin/bash
# PreToolUse hook for TeamDelete tool.
#
# Blocks TeamDelete if any non-lead member has not been gracefully shut down.
# Replaces the bare runtime error ("Use requestShutdown to terminate teammates
# first") with explicit guidance pointing to the agent-team skill's Phase 3
# teardown protocol — preventing the lead from killing in-progress work.
#
# State model (see agent-team skill Phase 3):
#   A member is ready for cleanup iff team-lead's inbox has a `shutdown_approved`
#   message from that member with `read: true`. read:true means the lead consumed
#   the <teammate-message> block in the previous user turn — i.e. it actually
#   yielded the turn between SendMessage(shutdown_request) and TeamDelete.
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

if ! command -v jq >/dev/null 2>&1; then
  # Without jq we cannot inspect inboxes safely. Let the runtime handle it.
  exit 0
fi

TEAM_NAME=$(echo "$STDIN" | jq -r '.tool_input.team_name // ""')
SESSION_ID=$(echo "$STDIN" | jq -r '.session_id // ""')

TEAMS_DIR="${HOME:-/home/developer}/.claude/teams"
[ -d "$TEAMS_DIR" ] || exit 0

# Resolve the team to inspect.
if [ -n "$TEAM_NAME" ]; then
  TEAM_DIR="$TEAMS_DIR/$TEAM_NAME"
else
  # TeamDelete({}) — find the unique team owned by this session.
  matches=$(find "$TEAMS_DIR" -mindepth 2 -maxdepth 2 -name config.json 2>/dev/null | while read -r cfg; do
    if [ "$(jq -r '.leadSessionId // ""' "$cfg" 2>/dev/null)" = "$SESSION_ID" ]; then
      echo "$cfg"
    fi
  done)
  count=$(printf '%s\n' "$matches" | grep -c . || true)
  # 0 → no team for this session, runtime will respond.
  # 2+ → ambiguous, runtime will respond.
  # 1 → use it.
  if [ "$count" != "1" ]; then exit 0; fi
  TEAM_DIR=$(dirname "$matches")
fi

CONFIG="$TEAM_DIR/config.json"
LEAD_INBOX="$TEAM_DIR/inboxes/team-lead.json"

if [ ! -f "$CONFIG" ]; then exit 0; fi
TEAM=$(basename "$TEAM_DIR")

# Non-lead members
MEMBERS=$(jq -r '.members[] | select(.agentType != "team-lead") | .name' "$CONFIG" 2>/dev/null || echo "")
if [ -z "$MEMBERS" ]; then exit 0; fi

# Lead inbox may not yet exist if no message has reached the lead. Treat as
# "no approvals received" rather than aborting.
INBOX_QUERY_TARGET="$LEAD_INBOX"
[ -f "$INBOX_QUERY_TARGET" ] || INBOX_QUERY_TARGET=/dev/null

PENDING_NO_APPROVAL=()  # No shutdown_approved at all
PENDING_NO_YIELD=()     # shutdown_approved present but read:false

while IFS= read -r m; do
  [ -z "$m" ] && continue
  if [ "$INBOX_QUERY_TARGET" = /dev/null ]; then
    PENDING_NO_APPROVAL+=("$m")
    continue
  fi
  APPROVED_COUNT=$(jq --arg m "$m" '
    [.[] | select(.from == $m) | select(.text | contains("shutdown_approved"))] | length
  ' "$INBOX_QUERY_TARGET" 2>/dev/null || echo 0)

  if [ "$APPROVED_COUNT" = "0" ]; then
    PENDING_NO_APPROVAL+=("$m")
    continue
  fi

  LATEST_READ=$(jq -r --arg m "$m" '
    [.[] | select(.from == $m) | select(.text | contains("shutdown_approved"))] | last | .read
  ' "$INBOX_QUERY_TARGET" 2>/dev/null || echo "false")

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
