#!/bin/bash
# PreToolUse / Bash hook. Restricts the documentator's bash usage to a strict
# read-only whitelist. Pass-through for any other agent or for non-documentator
# claude sessions (no DOCUMENTATOR_RUN env var).

set -euo pipefail

if [ "${DOCUMENTATOR_RUN:-}" != "1" ]; then
  exit 0
fi

# Read the JSON envelope from stdin and extract tool_input.command
ENVELOPE=$(cat)
COMMAND=$(printf '%s' "$ENVELOPE" | python3 -c 'import sys, json; print(json.loads(sys.stdin.read()).get("tool_input", {}).get("command", ""))')

# Whitelist of allowed prefixes (regex, anchored at start of command).
WHITELIST=(
  '^git log( |$)'
  '^git show( |$)'
  '^ls( |$)'
  '^wc -l( |$)'
)

for pattern in "${WHITELIST[@]}"; do
  if [[ "$COMMAND" =~ $pattern ]]; then
    exit 0
  fi
done

echo "Bash command blocked for documentator. Allowed commands: git log, git show, ls, wc -l. Use Read/Glob/Grep for everything else." >&2
exit 2
