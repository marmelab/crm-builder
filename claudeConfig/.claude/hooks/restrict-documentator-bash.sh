#!/bin/bash
# PreToolUse / Bash hook. Restricts the documentator's bash usage to a strict
# read-only whitelist. Applies when the actor is the documentator, detected
# EITHER by DOCUMENTATOR_RUN=1 (legacy standalone `claude -p` — top-level process,
# no agent_type) OR by agent_type === "documentator" (Agent-dispatched subagent,
# same signal the other PreToolUse hooks use). Pass-through for any other agent.

set -euo pipefail

# Read the JSON envelope once; extract agent_type first to decide whether to act.
ENVELOPE=$(cat)
AGENT=$(node -e '
try { const p = JSON.parse(process.argv[1]); process.stdout.write(p.agent_type || p.agentType || ""); }
catch { process.stdout.write(""); }
' "$ENVELOPE" 2>/dev/null) || AGENT=""

if [ "${DOCUMENTATOR_RUN:-}" != "1" ] && [ "$AGENT" != "documentator" ]; then
  exit 0
fi

# Extract tool_input.command. If the payload is malformed, treat as block (safer
# than passing through with an empty COMMAND that would later match `^ls( |$)`).
COMMAND=$(node -e '
try {
  const p = JSON.parse(process.argv[1]);
  process.stdout.write((p.tool_input && p.tool_input.command) || "");
} catch { process.stdout.write(""); }
' "$ENVELOPE" 2>/dev/null) || COMMAND=""

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

# Allowed-prefix regex (anchored). Mode 1: read-only inspection.
# Mode 2: read the session diff vs origin/main, commit MEMORY.md with
# the pinned Documentator identity (never via `cd && …` — chaining is blocked).
WHITELIST=(
  '^git log( |$)'
  '^git show( |$)'
  '^git diff( |$)'
  '^git -C /app fetch origin main --quiet *$'
  '^git -C /app diff( |$)'
  '^git -C /app log( |$)'
  '^ls( |$)'
  '^wc -l( |$)'
  '^git -C /app add MEMORY\.md *$'
  # commit: accept user.name/user.email in either order
  "^git -C /app -c user\\.name=['\"]?Documentator['\"]? -c user\\.email=['\"]?documentator@atomic-crm\\.local['\"]? commit -m "
  "^git -C /app -c user\\.email=['\"]?documentator@atomic-crm\\.local['\"]? -c user\\.name=['\"]?Documentator['\"]? commit -m "
)

for pattern in "${WHITELIST[@]}"; do
  if [[ "$COMMAND" =~ $pattern ]]; then
    exit 0
  fi
done

echo "Bash command blocked for documentator. Allowed: git log, git show, git diff, ls, wc -l; Mode 2 only: 'git -C /app fetch origin main --quiet', 'git -C /app diff …', 'git -C /app log …', 'git -C /app add MEMORY.md', 'git -C /app -c user.name=Documentator -c user.email=documentator@atomic-crm.local commit -m …'. Use Read/Glob/Grep otherwise." >&2
exit 2
