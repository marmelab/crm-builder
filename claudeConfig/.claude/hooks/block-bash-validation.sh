#!/bin/bash
# PreToolUse hook — block subagents from running validation commands via Bash.
# These are already run by SubagentStop hooks (typecheck, prettier, unit tests,
# e2e). A subagent running them manually:
#   - wastes Bash budget (circuit breaker at 30 calls)
#   - hangs on `npx vitest` without CI=true (chromium headed mode attempts
#     to launch without display → infinite wait)
#   - produces redundant results that may conflict with hook output
#
# Exits with code 2 (block) + clear reason so the subagent knows to stop
# running these and trust the hook output.
#
# Input on stdin: { session_id, tool_name, tool_input, ... }

set -e

INPUT=$(cat)

# Extract tool, agent_type, command from the hook input
PARSED=$(node -e '
try {
  const i = JSON.parse(process.argv[1]);
  process.stdout.write(JSON.stringify({
    tool: i.tool_name || "",
    agent: i.agent_type || "",
    cmd: (i.tool_input && i.tool_input.command) || ""
  }));
} catch { process.stdout.write("{}"); }
' "$INPUT" 2>/dev/null || echo "{}")

TOOL=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).tool || "")')
AGENT=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).agent || "")')
CMD=$(echo "$PARSED" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).cmd || "")')

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

# Only block for subagents whose prompt forbids validation commands.
# The orchestrator (no agent_type) and planner/merger/project-manager are
# allowed. Claude Code's PreToolUse hook matcher filters on tool_name only —
# agent-type filtering must happen here in the script.
case "$AGENT" in
  developer|quality-reviewer|test-validator)
    ;;
  *)
    exit 0
    ;;
esac

BLOCKED=""

# Patterns to block — each matches a specific kind of validation command.
# Use word boundaries where possible to avoid false positives (e.g., block
# `npm run test:unit:app` but not `git log src/tests/...`).

# typecheck
if echo "$CMD" | grep -qE '(make\s+typecheck|npm\s+run\s+typecheck|npx\s+tsc(\s|$)|tsc\s+--noEmit)'; then
  BLOCKED="typecheck — the typecheck-on-commit.sh hook runs this automatically after you finish; read its stderr output instead."
fi

# prettier
if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(npm\s+run\s+prettier(:apply)?|npx\s+prettier(\s|$)|make\s+prettier)'; then
  BLOCKED="prettier — the prettier-on-stop.sh hook runs this automatically; read its stderr output instead."
fi

# unit tests (vitest in any form)
if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(npm\s+run\s+test(:unit)?(:[a-z]+)?|npm\s+test\b|npx\s+vitest|make\s+test(-unit)?(-[a-z]+)?)'; then
  BLOCKED="unit tests — the run-unit-tests-*.sh hooks run these automatically. In this sandbox vitest browser mode HANGS without CI=true (chromium headed waits for display). Trust the hooks."
fi

# e2e tests / playwright
if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(npx\s+playwright\s+test|make\s+test-e2e)'; then
  BLOCKED="e2e tests — the run-e2e-tests.sh hook runs these in full mode only; in demo mode they're skipped. Don't run them manually."
fi

# lint (atomic-crm's `make lint` runs both eslint + prettier — second one is redundant with hook)
if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(make\s+lint\b|npm\s+run\s+lint\b)'; then
  BLOCKED="lint — prettier is already run by prettier-on-stop.sh; eslint runs via the project's editor config. Skip it."
fi

if [ -n "$BLOCKED" ]; then
  REASON="Validation command forbidden: $BLOCKED See developer.md \"Validation commands — DO NOT RUN THEM\"."
  LOG=/chat-service/logs/hooks.log
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  echo "[$(date -Iseconds)] block-bash-validation BLOCKED cmd=${CMD:0:120}" >> "$LOG" 2>/dev/null || true
  echo "{\"decision\":\"block\",\"reason\":\"$REASON\"}"
fi

exit 0
