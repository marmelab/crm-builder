#!/bin/bash
# PreToolUse hook for TeamCreate.
#
# Wipes orphan teams (those owned by a different session) before TeamCreate
# runs, so the new team can claim the requested team_name verbatim. Without
# this, Claude CLI's collision handling assigns a random unique team_name
# (e.g. "ancient-drifting-coral") and subsequent Agent({team_name: "tickets"})
# calls keep routing into the stale team — the new members get auto-suffixed
# (`-2`, `-3`, …) and SendMessages from the developer route to dead members
# from prior crashed sessions.
#
# Why a hook, not a skill instruction:
# We tried having the team-lead call `TeamDelete({team_name: "tickets"})` as
# preflight (agent-team SKILL.md). The LLM dropped the argument in practice
# and called `TeamDelete({})` instead, which is a no-op when no team is owned
# by the current session. The skill instruction is still there as a hint, but
# this hook is the deterministic safety net.
#
# Safety:
# - Only wipes if `leadSessionId` in the team's config differs from the
#   current session's `session_id`. A team owned by THIS session is live and
#   must go through graceful shutdown (teamdelete-gate enforces that).
# - team_name is regex-validated to prevent path traversal.
# - Always exits 0 — never blocks TeamCreate.

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
  exit 0
fi

PARSED=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  process.stdout.write(JSON.stringify({
    teamName: (i.tool_input && i.tool_input.team_name) || "",
    sessionId: i.session_id || ""
  }));
} catch { process.stdout.write("{}"); }
' "$STDIN" 2>/dev/null || echo "{}")

TEAM_NAME=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).teamName || "")' 2>/dev/null)
SESSION_ID=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).sessionId || "")' 2>/dev/null)

[ -z "$TEAM_NAME" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0

# Strict regex — must match the same charset accepted by teamdelete-cleanup.sh
if ! [[ "$TEAM_NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
  exit 0
fi

TEAMS_DIR="${HOME:-/home/developer}/.claude/teams"
TARGET="$TEAMS_DIR/$TEAM_NAME"
CONFIG="$TARGET/config.json"

[ ! -f "$CONFIG" ] && exit 0

LEAD_OF_TEAM=$(node -e '
try {
  const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(cfg.leadSessionId || "");
} catch { process.stdout.write(""); }
' "$CONFIG" 2>/dev/null || echo "")

if [ -z "$LEAD_OF_TEAM" ] || [ "$LEAD_OF_TEAM" = "$SESSION_ID" ]; then
  exit 0
fi

# Defensive: only delete inside $TEAMS_DIR.
case "$TARGET" in
  "$TEAMS_DIR"/*) : ;;
  *) exit 0 ;;
esac

rm -rf "$TARGET" 2>/dev/null
hook_log "teamcreate-wipe-orphan REMOVED $TARGET (orphan leadSession=$LEAD_OF_TEAM current=$SESSION_ID)"

# Clear the circuit-breaker flag for this session if it was set by an earlier
# teamdelete-cleanup "no team" path — the upcoming TeamCreate is genuine and
# the next TeamDelete (Phase 3) should not be blocked.
SESSION_HASH=$(echo -n "$SESSION_ID" | sha1sum | cut -c1-16)
rm -f "/tmp/teamdelete-empty-${SESSION_HASH}" 2>/dev/null || true

exit 0
