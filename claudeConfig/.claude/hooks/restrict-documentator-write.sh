#!/bin/bash
# PreToolUse / Write|Edit hook. Restricts the documentator's writes to a small
# set of paths: the ledger, the runtime additions tree, and settings.local.json.
# All other paths are blocked — the documentator is not allowed to touch
# application code or to modify the resynced base config under
# /home/developer/.claude/{agents,skills,hooks,rules,settings.json}.
# Applies when the actor is the documentator, detected EITHER by:
#   - DOCUMENTATOR_RUN=1 env — the legacy standalone `claude -p` spawn is a
#     top-level process with no agent_type, so the env is its only tag; OR
#   - agent_type === "documentator" — an Agent-dispatched documentator subagent,
#     the same signal the other PreToolUse hooks use (e.g. block-bash-validation).
# Pass-through for any other agent / claude session.

set -euo pipefail

ENVELOPE=$(cat)
AGENT=$(node -e '
try { const p = JSON.parse(process.argv[1]); process.stdout.write(p.agent_type || p.agentType || ""); }
catch { process.stdout.write(""); }
' "$ENVELOPE" 2>/dev/null) || AGENT=""

if [ "${DOCUMENTATOR_RUN:-}" != "1" ] && [ "$AGENT" != "documentator" ]; then
  exit 0
fi

FILE_PATH=$(node -e '
try {
  const p = JSON.parse(process.argv[1]);
  process.stdout.write((p.tool_input && p.tool_input.file_path) || "");
} catch { process.stdout.write(""); }
' "$ENVELOPE" 2>/dev/null) || FILE_PATH=""

if [ -z "$FILE_PATH" ]; then
  echo "Write/Edit blocked for documentator: empty or unparseable file_path." >&2
  exit 2
fi

LEDGER="/app/docs/learnings/patterns.md"
LOCAL_PREFIX="/home/developer/.claude/local/"
SETTINGS_LOCAL="/home/developer/.claude/settings.local.json"
MEMORY="/app/MEMORY.md"

if [ "$FILE_PATH" = "$LEDGER" ]; then exit 0; fi
if [ "$FILE_PATH" = "$SETTINGS_LOCAL" ]; then exit 0; fi
if [ "$FILE_PATH" = "$MEMORY" ]; then exit 0; fi
case "$FILE_PATH" in
  "$LOCAL_PREFIX"*) exit 0 ;;
esac

echo "Write/Edit blocked for documentator: $FILE_PATH is outside the allowed set. Allowed: $LEDGER, $SETTINGS_LOCAL, $MEMORY, ${LOCAL_PREFIX}**." >&2
exit 2
