#!/bin/bash
# PreToolUse hook — block the chat-orchestrator (team-lead) from running
# merge-class git commands via Bash.
#
# The orchestrator must NEVER act as merger. The shared `merger` agent is the
# only one who runs `git merge`, `git checkout master|main`, `git pull`, or
# `git worktree remove`. When the orchestrator falls back to doing these
# commands itself (typically because it didn't get a "merged" report from
# the merger), the team workflow looks healthy but is silently broken — the
# merger agent never received the dev's "ready" message, the dev↔merger
# communication path is dead, and the bug is hidden.
#
# This hook is the runtime guard. The behavioral rule is documented in
# chat-orchestrator.md ("NEVER act as merger yourself").
#
# Detection: in Claude Code's PreToolUse hook input, the `agent_type` field
# is empty ("") for the main orchestrator session, and contains the agent
# name (e.g. "merger", "developer") for dispatched subagents. So we block
# when agent_type is empty AND the command matches a merge-class pattern.
#
# Allowed callers: any subagent_type (merger, developer, etc.) — only the
# main session is blocked.
#
# Blocked patterns (orchestrator only):
#   - `git merge`
#   - `git checkout master`, `git checkout main`
#   - `git pull` (any form)
#   - `git worktree remove`
#   - `git reset --hard HEAD` followed by `apply-app-variant.sh` (the merger's
#     pre-merge dance)
#
# Exits with code 2 (block) + stderr message that points back to the rule
# in chat-orchestrator.md. The orchestrator sees this as a tool_use_error
# and must report failure to the user instead.

set -u

INPUT=$(cat)

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

PARSED=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
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

# Only block when called from the main orchestrator session (agent_type empty).
# Subagents (merger, developer, etc.) are allowed.
if [ -n "$AGENT" ]; then
  exit 0
fi

BLOCKED=""

if echo "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+merge([[:space:]]|$)'; then
  BLOCKED="git merge"
fi

if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+checkout[[:space:]]+(master|main)([[:space:]]|$)'; then
  BLOCKED="git checkout master/main"
fi

if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+pull([[:space:]]|$)'; then
  BLOCKED="git pull"
fi

if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+worktree[[:space:]]+remove([[:space:]]|$)'; then
  BLOCKED="git worktree remove"
fi

if [ -z "$BLOCKED" ] && echo "$CMD" | grep -qE 'apply-app-variant\.sh'; then
  BLOCKED="apply-app-variant.sh (merger-only command)"
fi

if [ -n "$BLOCKED" ]; then
  cat >&2 <<EOF
[block-orchestrator-merge] Blocked: orchestrator attempted to run "$BLOCKED".

Rule: chat-orchestrator must NEVER act as merger. Only the dispatched
\`merger\` agent runs merge-class git commands. See chat-orchestrator.md
section "NEVER act as merger yourself".

If you got here because the merger didn't report back, it means the
team communication broke — the dev's "ready" message never reached the
merger. Don't salvage by merging yourself. Report the failure to the
user ("Something went wrong on the merge step. Want me to try again?")
and stop. Salvaging hides the bug.

Blocked command:
  $CMD
EOF
  exit 2
fi

exit 0
