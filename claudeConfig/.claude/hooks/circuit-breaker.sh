#!/bin/bash
# PreToolUse hook — per-subagent circuit breaker.
# Detects agents stuck in Bash loops without sabotaging legitimate multi-agent
# workflows that cumulatively exceed a session-wide budget.
#
# Keyed on `agent_id` (unique per subagent dispatch). Verified empirically in
# Claude Code 2.1.x: the hook input JSON includes `agent_id` ONLY when the
# calling context is a subagent — absent for the top-level orchestrator.
# So each subagent gets its own 30-Bash budget, and a loop in one doesn't
# block the others.
#
# Input on stdin: { session_id, transcript_path, agent_id?, agent_type?,
#                   tool_name, tool_input, ... }

set -e

# Per-subagent Bash budget. Calibrated on the "hooks own validation" model:
# developer doesn't run typecheck/prettier/vitest/e2e himself (those are
# run by SubagentStop hooks and blocked at PreToolUse via
# block-bash-validation.sh). So a dev's legitimate Bash usage is:
#   worktree setup (1) + git add/commit/status (5-8) + git exploration (2-3)
#   + fix retries (5-10) = ~15-20 Bash calls per ticket.
# 30 is comfortable for this workload and catches infinite loops (which
# typically hit 100+ in a few seconds).
ITERATION_LIMIT=45

INPUT=$(cat)

KEY=$(node -e '
try {
  const i = JSON.parse(process.argv[1]);
  // Prefer agent_id (per-subagent). Fallback to session_id prefixed with
  // "orch-" to distinguish the orchestrator context (which rarely runs Bash
  // but still deserves its own counter if it does).
  console.log(i.agent_id ? "sub-" + i.agent_id : "orch-" + (i.session_id || "default"));
} catch {
  console.log("default");
}
' "$INPUT" 2>/dev/null || echo default)

KEY_HASH=$(echo -n "$KEY" | sha1sum | cut -c1-16)

COUNTER_DIR="${CLAUDE_PROJECT_DIR:-/tmp}/.claude/tmp"
mkdir -p "$COUNTER_DIR" 2>/dev/null || COUNTER_DIR=/tmp
COUNTER_FILE="$COUNTER_DIR/bash-count-${KEY_HASH}"

# Auto-reset if counter file is older than 1 hour (stale subagent)
if [ -f "$COUNTER_FILE" ] && [ "$(find "$COUNTER_FILE" -mmin +60 2>/dev/null)" ]; then
  rm -f "$COUNTER_FILE"
fi

COUNT=0
[ -f "$COUNTER_FILE" ] && COUNT=$(cat "$COUNTER_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Observability: record the keyed count so we can audit per-agent budgets.
LOG="$CHAT_SESSION_DIR/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
echo "[$(date -Iseconds)] circuit-breaker key=${KEY} hash=${KEY_HASH} count=${COUNT}" >> "$LOG" 2>/dev/null || true

if [ "$COUNT" -gt "$ITERATION_LIMIT" ]; then
  echo "{\"decision\":\"block\",\"reason\":\"Circuit breaker: this subagent has made $COUNT Bash calls — likely stuck in a loop. Stop, report where you are blocked so the orchestrator can re-dispatch with a fresh context.\"}"
fi

exit 0
