#!/bin/bash
# PreToolUse hook on the Agent tool (no-team flow).
#
# Forces `developer` dispatches to use the session worktree that setup-worktree
# already created (`WORKTREE_PATH:` in the prompt) and forbids the Agent tool's
# own `isolation: worktree`, which spawns off-convention `worktree-agent-*`
# branches outside the session-branch topology — breaking Stage A merges and the
# migration diff baseline. Keeps the orchestrator on the STATE B dispatch
# template instead of improvising a free-form prompt.
set -u

STDIN=$(cat)

INFO=$(node -e '
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const t = i.tool_input || {};
  const st = t.subagent_type || "";
  const iso = t.isolation || "";
  const pr = t.prompt || "";
  const hasWT = /WORKTREE_PATH:\s*\S/.test(pr) ? "1" : "0";
  process.stdout.write([st, iso, hasWT].join("|"));
} catch (e) { process.stdout.write("||") }
' "$STDIN" 2>/dev/null || echo "||")

ST="${INFO%%|*}"; REST="${INFO#*|}"; ISO="${REST%%|*}"; HASWT="${REST##*|}"

[ "$ST" = "developer" ] || exit 0     # only gate developer dispatches

if [ "$ISO" = "worktree" ]; then
  echo "[enforce-dev-dispatch] developer must NOT use isolation:worktree — setup-worktree already created /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX. Drop isolation and pass WORKTREE_PATH + BRANCH_NAME in the prompt (STATE B template)." >&2
  exit 2
fi

if [ "$HASWT" != "1" ]; then
  echo "[enforce-dev-dispatch] developer dispatch prompt is missing 'WORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX' (and BRANCH_NAME). Use the STATE B dispatch template verbatim instead of a free-form prompt." >&2
  exit 2
fi

exit 0
