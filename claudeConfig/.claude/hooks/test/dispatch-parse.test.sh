#!/bin/bash
# claudeConfig/.claude/hooks/test/dispatch-parse.test.sh
set -e
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARSE="$HOOKS_DIR/lib-dispatch-parse.js"

OUT=$(node "$PARSE" <<'EOF'
{"tool_input":{"subagent_type":"merger","run_in_background":true,"prompt":"TASK-001 is merged; now handle this one.\nROLE: merger\nTASK_ID: TASK-002\nBRANCH_NAME: ab12cd34/TASK-002\nWORKTREE_PATH: /app/worktrees/ab12cd34/TASK-002"}}
EOF
)
eval "$OUT"
[ "$TASK_ID" = "TASK-002" ] || { echo "FAIL: TASK_ID=$TASK_ID (prose TASK-001 must not win)"; exit 1; }
[ "$SUBAGENT_TYPE" = "merger" ] || { echo "FAIL: SUBAGENT_TYPE"; exit 1; }
[ "$RUN_IN_BACKGROUND" = "1" ] || { echo "FAIL: RUN_IN_BACKGROUND"; exit 1; }
[ "$BRANCH_NAME" = "ab12cd34/TASK-002" ] || { echo "FAIL: BRANCH_NAME=$BRANCH_NAME"; exit 1; }
[ "$WORKTREE_PATH" = "/app/worktrees/ab12cd34/TASK-002" ] || { echo "FAIL: WORKTREE_PATH=$WORKTREE_PATH"; exit 1; }

OUT=$(node "$PARSE" <<<'{"tool_input":{"subagent_type":"merger","prompt":"merge the simple branch"}}')
eval "$OUT"
[ -z "$TASK_ID" ] || { echo "FAIL: TASK_ID should be empty without a TASK_ID: line"; exit 1; }

# SIMPLE skip key is structural (Task 12 Step 4 adds TASK_ID: SIMPLE to the template).
OUT=$(node "$PARSE" <<<'{"tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nTASK_ID: SIMPLE\nSESSION_SHORT_ID: ab12cd34"}}')
eval "$OUT"
[ "$TASK_ID" = "SIMPLE" ] || { echo "FAIL: TASK_ID=$TASK_ID (expected SIMPLE)"; exit 1; }

# PROMOTE merger dispatch.
OUT=$(node "$PARSE" <<<'{"agent_type":"","tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nMODE: promote\nSESSION_SHORT_ID: ab12cd34"}}')
eval "$OUT"
[ "$MODE" = "promote" ] || { echo "FAIL: MODE=$MODE"; exit 1; }
[ "$SESSION_SHORT_ID" = "ab12cd34" ] || { echo "FAIL: SESSION_SHORT_ID=$SESSION_SHORT_ID"; exit 1; }
[ -z "$AGENT_TYPE" ] || { echo "FAIL: AGENT_TYPE should be empty for orchestrator"; exit 1; }

# A subagent-issued dispatch carries a non-empty agent_type.
OUT=$(node "$PARSE" <<<'{"agent_type":"merger","tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nMODE: promote"}}')
eval "$OUT"
[ "$AGENT_TYPE" = "merger" ] || { echo "FAIL: AGENT_TYPE=$AGENT_TYPE (expected merger)"; exit 1; }

# developer dispatch: anchored TASK-\d+, WORKTREE_PATH, ISOLATION absent.
OUT=$(node "$PARSE" <<<'{"tool_input":{"subagent_type":"developer","prompt":"ROLE: developer\nTASK_ID: TASK-003\nWORKTREE_PATH: /app/worktrees/ab12cd34/TASK-003\nBRANCH_NAME: ab12cd34/TASK-003"}}')
eval "$OUT"
[ "$TASK_ID" = "TASK-003" ] || { echo "FAIL: TASK_ID=$TASK_ID"; exit 1; }
[ "$WORKTREE_PATH" = "/app/worktrees/ab12cd34/TASK-003" ] || { echo "FAIL: WORKTREE_PATH"; exit 1; }
[ -z "$ISOLATION" ] || { echo "FAIL: ISOLATION should be empty"; exit 1; }

# isolation:worktree must surface so enforce-dev-dispatch can block it.
OUT=$(node "$PARSE" <<<'{"tool_input":{"subagent_type":"developer","isolation":"worktree","prompt":"ROLE: developer\nWORKTREE_PATH: /app/worktrees/ab12cd34/TASK-004"}}')
eval "$OUT"
[ "$ISOLATION" = "worktree" ] || { echo "FAIL: ISOLATION=$ISOLATION (expected worktree)"; exit 1; }

# ROLLBACK merger: structural skip key preserved.
OUT=$(node "$PARSE" <<<'{"tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nTASK_ID: ROLLBACK\nSESSION_SHORT_ID: ab12cd34"}}')
eval "$OUT"
[ "$TASK_ID" = "ROLLBACK" ] || { echo "FAIL: TASK_ID=$TASK_ID (expected ROLLBACK)"; exit 1; }

# Command-injection lockdown: the hooks consume this output via `eval "$(node ...)"`.
# Output MUST be bash-inert (single-quoted) so a prompt field containing $(...) or
# backticks is never executed at eval time. JSON.stringify (double quotes) would be
# exploitable — single quotes are fully literal.
# Use space-free payloads (${IFS} substitutes for spaces) so the WHOLE malicious
# command is captured by the \S+ grab — proving even a complete injection is inert.
OUT=$(node "$PARSE" <<'EOF'
{"tool_input":{"subagent_type":"developer","prompt":"ROLE: developer\nBRANCH_NAME: $(touch${IFS}/tmp/INJECT_FAIL)\nWORKTREE_PATH: `touch${IFS}/tmp/INJECT_FAIL2`\nTASK_ID: TASK-009"}}
EOF
)
rm -f /tmp/INJECT_FAIL /tmp/INJECT_FAIL2
eval "$OUT"
[ ! -e /tmp/INJECT_FAIL ] && [ ! -e /tmp/INJECT_FAIL2 ] || { echo "FAIL: command injection via eval"; rm -f /tmp/INJECT_FAIL /tmp/INJECT_FAIL2; exit 1; }
[ "$BRANCH_NAME" = '$(touch${IFS}/tmp/INJECT_FAIL)' ] || { echo "FAIL: BRANCH_NAME not literal: $BRANCH_NAME"; exit 1; }
[ "$WORKTREE_PATH" = '`touch${IFS}/tmp/INJECT_FAIL2`' ] || { echo "FAIL: WORKTREE_PATH not literal: $WORKTREE_PATH"; exit 1; }
[ "$TASK_ID" = "TASK-009" ] || { echo "FAIL: TASK_ID"; exit 1; }

echo "OK dispatch-parse"
