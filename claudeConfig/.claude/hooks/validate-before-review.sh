#!/bin/bash
# PreToolUse hook for SendMessage tool.
# When the developer is about to SendMessage a reviewer or merger,
# run the project validation chain. If any step fails, exit 2 to block
# the SendMessage; the dev sees the stderr as a tool_use_error.
#
# Behavior:
# - Reads the tool input JSON from stdin.
# - If tool_input.to does not match (quality-reviewer|test-validator|merger)@*, exit 0 (skip).
# - Otherwise runs (in order): typecheck, prettier, unit-app, unit-functions, e2e.
# - First failure → exit 2 with the failing script's stderr passed through.
#
# DRY RUN MODE: VALIDATE_DRY_RUN=1 → all sub-scripts are skipped, exit 0.
#               VALIDATE_DRY_RUN=fail → simulates a failure, exit 2.

set -u

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
if [ -z "$STDIN" ]; then
  exit 0
fi

# Parse the recipient from JSON. We use jq if available, fall back to grep.
if command -v jq >/dev/null 2>&1; then
  TO=$(echo "$STDIN" | jq -r '.tool_input.to // ""' 2>/dev/null || echo "")
else
  # Crude fallback: extract "to":"..." value
  TO=$(echo "$STDIN" | grep -oE '"to"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"to"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi

case "$TO" in
  quality-reviewer@*|test-validator@*|merger@*)
    : # gate enabled
    ;;
  *)
    exit 0
    ;;
esac

echo "[$(date -Iseconds)] validate-before-review START to=$TO" >> "$LOG" 2>/dev/null || true

# Dry-run hooks (test-only)
case "${VALIDATE_DRY_RUN:-}" in
  1)
    echo "[$(date -Iseconds)] validate-before-review DRY_RUN=1, skipping checks, exit 0" >> "$LOG" 2>/dev/null || true
    exit 0
    ;;
  fail)
    echo "[$(date -Iseconds)] validate-before-review DRY_RUN=fail, exit 2" >> "$LOG" 2>/dev/null || true
    echo "Validation failed (simulated)." >&2
    exit 2
    ;;
esac

HOOK_DIR="$(dirname "$0")"

# Ordered list: cheapest checks first to fail fast.
SCRIPTS=(
  typecheck-on-commit.sh
  prettier-on-stop.sh
  run-unit-tests-app.sh
  run-unit-tests-functions.sh
  run-e2e-tests.sh
)

for script in "${SCRIPTS[@]}"; do
  full="$HOOK_DIR/$script"
  if [ ! -x "$full" ]; then
    echo "[$(date -Iseconds)] validate-before-review WARN $script missing or not executable, skipping" >> "$LOG" 2>/dev/null || true
    continue
  fi
  # Pipe an empty SubagentStop-like stdin so the existing scripts don't error on cat.
  EMPTY_STDIN='{"hook_event_name":"PreToolUse_SendMessage","matcher":"SendMessage"}'
  if echo "$EMPTY_STDIN" | "$full" >/tmp/validate-stderr-$$.log 2>&1; then
    echo "[$(date -Iseconds)] validate-before-review $script OK" >> "$LOG" 2>/dev/null || true
  else
    EXIT=$?
    echo "[$(date -Iseconds)] validate-before-review $script FAILED exit=$EXIT" >> "$LOG" 2>/dev/null || true
    cat /tmp/validate-stderr-$$.log >&2
    rm -f /tmp/validate-stderr-$$.log
    exit 2
  fi
  rm -f /tmp/validate-stderr-$$.log
done

echo "[$(date -Iseconds)] validate-before-review ALL OK to=$TO" >> "$LOG" 2>/dev/null || true
exit 0
