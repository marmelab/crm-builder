#!/bin/bash
# PreToolUse / Write|Edit hook — enforces the deferred-migration rule.
#
# Rule from agents/developer.md ("Never write SQL migrations") and the
# deferred-migration design: migrations are generated only at deploy time by
# `simple-developer` in MIGRATION MODE. Developer agents writing migrations
# during feature TASKs is a regression that occurred in sessions 630fb0fe
# and 2e53c631 — instructions alone don't enforce it.
#
# Block conditions:
#   1. Any Write/Edit on `supabase/migrations-pending/*` — the folder was
#      removed by the deferred-migration design (see spec 2026-05-27) but
#      agents keep recreating it from training memory.
#   2. Any Write/Edit on `supabase/migrations/*` when the calling agent is
#      `developer` (the multi-file feature-ticket agent). Migrations belong
#      to the PD-MIG round, handled by `simple-developer` only.
#
# Pass-through for any other agent or path. simple-developer is allowed to
# write to supabase/migrations/ because that's its job in MIGRATION MODE.
# Non-migration-mode simple-developer writing there is still a gap, but the
# bigger regression today is `developer` doing it during feature tickets —
# tighten later if the gap is hit in practice.

set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)

FILE_PATH=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  process.stdout.write((i.tool_input && i.tool_input.file_path) || "");
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

AGENT_NAME_ENV="${CLAUDE_AGENT_NAME:-}"
AGENT_TYPE=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  process.stdout.write(i.agent_type || "");
} catch { process.stdout.write(""); }
' "$STDIN" 2>/dev/null || echo "")

# Prefer the suffixed env name (e.g. "developer-TASK-003"). Fall back to base type.
if [ -n "$AGENT_NAME_ENV" ]; then
  AGENT="$AGENT_NAME_ENV"
else
  AGENT="$AGENT_TYPE"
fi

# Normalise: strip the -TASK-XXX suffix to get the base agent type
BASE_AGENT="${AGENT%%-TASK-*}"

# Rule 1: nobody writes to supabase/migrations-pending/* — the folder is dead.
case "$FILE_PATH" in
  */supabase/migrations-pending/*)
    REASON="supabase/migrations-pending/ was removed by the deferred-migration design (spec 2026-05-27). Migrations live in supabase/migrations/ and are written only by simple-developer in MIGRATION MODE."
    echo "[$(date -Iseconds)] block-migration-writes BLOCKED agent=$AGENT path=$FILE_PATH reason=pending-folder" >> "$LOG" 2>/dev/null || true
    echo "{\"decision\":\"block\",\"reason\":\"$REASON\"}"
    exit 0
    ;;
esac

# Rule 2: developer (feature-ticket agent) never writes migrations.
case "$BASE_AGENT" in
  developer)
    case "$FILE_PATH" in
      */supabase/migrations/*)
        REASON="developer agent is forbidden from writing SQL migrations (see agents/developer.md, deferred-migration design). Migrations are generated at deploy time by the PD-MIG round (simple-developer in MIGRATION MODE) from the session-branch diff."
        echo "[$(date -Iseconds)] block-migration-writes BLOCKED agent=$AGENT path=$FILE_PATH reason=developer-migration" >> "$LOG" 2>/dev/null || true
        echo "{\"decision\":\"block\",\"reason\":\"$REASON\"}"
        exit 0
        ;;
    esac
    ;;
esac

exit 0
