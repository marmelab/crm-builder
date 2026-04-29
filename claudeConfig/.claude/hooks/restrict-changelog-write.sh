#!/bin/bash
# PreToolUse / Write|Edit hook. The `changelog` agent may only modify the
# cross-session changelog at /chat-service/logs/changelog.json. Any other
# Write/Edit target is blocked. Pass-through for every other agent.

set -euo pipefail

ALLOWED="/chat-service/logs/changelog.json"

ENVELOPE=$(cat)

AGENT_TYPE=$(node -e '
try {
  const p = JSON.parse(process.argv[1]);
  process.stdout.write(p.agent_type || "");
} catch { process.stdout.write(""); }
' "$ENVELOPE" 2>/dev/null) || AGENT_TYPE=""

if [ "$AGENT_TYPE" != "changelog" ]; then
  exit 0
fi

FILE_PATH=$(node -e '
try {
  const p = JSON.parse(process.argv[1]);
  process.stdout.write((p.tool_input && p.tool_input.file_path) || "");
} catch { process.stdout.write(""); }
' "$ENVELOPE" 2>/dev/null) || FILE_PATH=""

if [ -z "$FILE_PATH" ]; then
  echo "Write/Edit blocked for changelog: empty or unparseable file_path." >&2
  exit 2
fi

if [ "$FILE_PATH" != "$ALLOWED" ]; then
  echo "Write/Edit blocked for changelog: only $ALLOWED may be modified. Attempted: $FILE_PATH" >&2
  exit 2
fi

exit 0
