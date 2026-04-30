#!/bin/bash
# PreToolUse hook — block file writes via Bash.
# Developers must use Edit/Write tools to modify files. Using bash redirection
# (cat >, echo >, sed -i, etc.) bypasses PostToolUse hooks (prettier, typecheck)
# and leaves orphan temp files in /tmp. Violated in run 2026-04-22-complex-priority
# where a developer ran `cat > /tmp/task-002-update.json` leaving an empty tmp file.
#
# Blocks the Bash call with exit 2 + a clear error message telling the dev to use
# Edit/Write instead. Allows read-only uses (grep, ls, find, cat FOR READING)
# and legitimate git/npm/make commands.
#
# Input on stdin: { session_id, tool_name, tool_input, ... }

set -e

INPUT=$(cat)

TOOL=$(node -e '
try { const i = JSON.parse(process.argv[1]); console.log(i.tool_name || ""); } catch { console.log(""); }
' "$INPUT" 2>/dev/null || echo "")

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

CMD=$(node -e '
try {
  const i = JSON.parse(process.argv[1]);
  console.log(i.tool_input && i.tool_input.command || "");
} catch { console.log(""); }
' "$INPUT" 2>/dev/null || echo "")

BLOCKED=""

# File-writing redirections: `> path` or `>> path` where path isn't /dev/null
# or a log file. Allow HERE-DOCs being consumed by git/other commands
# (git commit -m "$(cat <<'EOF'\n...\nEOF)") — those use `<<EOF` inside $(...),
# not `> file`.
# Pattern: `>` or `>>` followed by something that looks like a filesystem path.
if echo "$CMD" | grep -qE '(^|[^0-9&])>[>]?\s*(/[a-zA-Z]|\./|[a-zA-Z][a-zA-Z0-9._-]*\.[a-zA-Z]+)'; then
  # Allow explicit /dev/null and /tmp/hook-* log paths
  if ! echo "$CMD" | grep -qE '>[>]?\s*(/dev/null|/chat-service/logs/)'; then
    BLOCKED="bash redirection to file (> or >>). Use Edit or Write tool instead."
  fi
fi

# sed -i: in-place file modification
if echo "$CMD" | grep -qE 'sed\s+(-[a-zA-Z]*i\b|--in-place)'; then
  BLOCKED="sed -i (in-place edit). Use Edit tool instead."
fi

# awk -i inplace
if echo "$CMD" | grep -qE 'awk\s+-i\s+inplace'; then
  BLOCKED="awk -i inplace. Use Edit tool instead."
fi

# tee writing to a file path (not /dev/null)
if echo "$CMD" | grep -qE '\|\s*tee\s+[^-]'; then
  if ! echo "$CMD" | grep -qE '\|\s*tee\s+(/dev/null|-a\s+/dev/null)'; then
    BLOCKED="pipe to tee (file write). Use Write tool instead."
  fi
fi

# node / python -e / -c with explicit filesystem write calls
if echo "$CMD" | grep -qE '(node|python3?)\s+-[ecp].*(writeFileSync|writeFile|write_text|os\.write|fs\.write)'; then
  BLOCKED="scripted file write via node/python. Use Write/Edit tool instead."
fi

if [ -n "$BLOCKED" ]; then
  REASON="File editing via Bash is forbidden: $BLOCKED See developer.md's HARD RULE."
  # Log the attempt
  LOG="$CHAT_SESSION_DIR/hooks.log"
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  echo "[$(date -Iseconds)] block-bash-write BLOCKED cmd=${CMD:0:120}" >> "$LOG" 2>/dev/null || true
  echo "{\"decision\":\"block\",\"reason\":\"$REASON\"}"
fi

exit 0
