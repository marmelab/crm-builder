#!/bin/bash
# PreToolUse / Write|Edit hook. In phase 1, the documentator may only modify
# /app/docs/learnings/patterns.md. Block any other file. Pass-through for any
# other agent or for non-documentator claude sessions (no DOCUMENTATOR_RUN env var).

set -euo pipefail

if [ "${DOCUMENTATOR_RUN:-}" != "1" ]; then
  exit 0
fi

ALLOWED="/app/docs/learnings/patterns.md"

ENVELOPE=$(cat)
FILE_PATH=$(printf '%s' "$ENVELOPE" | python3 -c '
import sys, json
try:
    payload = json.loads(sys.stdin.read())
    inp = payload.get("tool_input", {})
    print(inp.get("file_path", ""), end="")
except Exception:
    print("", end="")
' 2>/dev/null) || FILE_PATH=""

if [ -z "$FILE_PATH" ]; then
  echo "Write/Edit blocked for documentator: empty or unparseable file_path." >&2
  exit 2
fi

if [ "$FILE_PATH" != "$ALLOWED" ]; then
  echo "Write/Edit blocked for documentator: in phase 1 only $ALLOWED may be modified. Attempted: $FILE_PATH" >&2
  exit 2
fi

exit 0
