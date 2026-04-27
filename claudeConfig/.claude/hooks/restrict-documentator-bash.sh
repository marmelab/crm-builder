#!/bin/bash
# PreToolUse / Bash hook. Restricts the documentator's bash usage to a strict
# read-only whitelist. Pass-through for any other agent or for non-documentator
# claude sessions (no DOCUMENTATOR_RUN env var).

set -euo pipefail

if [ "${DOCUMENTATOR_RUN:-}" != "1" ]; then
  exit 0
fi

# Read the JSON envelope from stdin and extract tool_input.command. If the
# payload is malformed, treat as block (safer than passing through with an
# empty COMMAND that would later match `^ls( |$)` against an empty string).
ENVELOPE=$(cat)
COMMAND=$(printf '%s' "$ENVELOPE" | python3 -c '
import sys, json
try:
    payload = json.loads(sys.stdin.read())
    cmd = payload.get("tool_input", {}).get("command", "")
except Exception:
    cmd = ""
print(cmd, end="")
' 2>/dev/null) || COMMAND=""

if [ -z "$COMMAND" ]; then
  echo "Bash command blocked for documentator: empty or unparseable command." >&2
  exit 2
fi

# Reject any command containing shell metacharacters that could chain or
# redirect. The prefix whitelist below trusts that the command is a single
# atom, so we have to enforce that here first.
case "$COMMAND" in
  *';'*|*'&&'*|*'||'*|*'|'*|*'`'*|*'$('*|*'>'*|*'<'*|*$'\n'*)
    echo "Bash command blocked for documentator: shell metacharacters not allowed (\";\", \"&&\", \"||\", \"|\", backtick, \"\$(\", redirections, newline)." >&2
    exit 2
    ;;
esac

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
