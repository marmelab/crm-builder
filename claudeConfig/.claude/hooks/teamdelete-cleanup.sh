#!/bin/bash
# PostToolUse hook for TeamDelete tool.
#
# Runs AFTER a successful TeamDelete to remove residual disk artifacts
# (inboxes/, transcripts) that the runtime leaves behind. This replaces
# the manual Phase 3e Bash rm step in the agent-team skill — which was
# fragile (lead could forget) and blocked by the .claude/ permission gate
# when invoked via the Bash tool.
#
# Behavior:
#   - If tool_response.success is not true → no-op (let user investigate)
#   - Extract team_name from tool_response.team_name (always present on success)
#   - Validate the team_name strictly (alphanumeric, dash, underscore only)
#   - rm -rf "$HOME/.claude/teams/<team_name>"
#   - Always exit 0 — this hook is informational, never blocks
#
# Safety: the team_name regex prevents path traversal. We only ever
# delete inside $HOME/.claude/teams/, never elsewhere.

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
  exit 0
fi

# Only act on successful TeamDelete
SUCCESS=$(echo "$STDIN" | jq -r '.tool_response.success // false' 2>/dev/null)
if [ "$SUCCESS" != "true" ]; then
  hook_log "teamdelete-cleanup SKIP non-success"
  exit 0
fi

# team_name comes from tool_response (always present on success), with
# a fallback to tool_input for robustness.
TEAM_NAME=$(echo "$STDIN" | jq -r '.tool_response.team_name // .tool_input.team_name // ""' 2>/dev/null)
if [ -z "$TEAM_NAME" ]; then
  hook_log "teamdelete-cleanup SKIP no team_name"
  exit 0
fi

# Strict validation: alphanumeric, dash, underscore only. Anything else is
# refused. This blocks any attempt at path traversal (.., /, etc).
if ! [[ "$TEAM_NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
  hook_log "teamdelete-cleanup REFUSE invalid team_name=$TEAM_NAME"
  exit 0
fi

TEAMS_DIR="${HOME:-/home/developer}/.claude/teams"
TARGET="$TEAMS_DIR/$TEAM_NAME"

# Defensive: only delete if the path is exactly under $TEAMS_DIR.
case "$TARGET" in
  "$TEAMS_DIR"/*) : ;;
  *)
    hook_log "teamdelete-cleanup REFUSE path outside teams dir: $TARGET"
    exit 0
    ;;
esac

if [ -d "$TARGET" ]; then
  rm -rf "$TARGET" 2>/dev/null
  hook_log "teamdelete-cleanup REMOVED $TARGET"
else
  hook_log "teamdelete-cleanup NOOP $TARGET (not present)"
fi

exit 0
