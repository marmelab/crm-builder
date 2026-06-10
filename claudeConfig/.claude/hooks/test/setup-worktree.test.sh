#!/bin/bash
# Tests for setup-worktree.sh session-branch topology.
# setup-worktree.sh is a PreToolUse/Agent hook: it reads the dispatch
# tool_input (subagent_type + prompt) and creates the worktree BEFORE the
# subagent starts. Uses a throwaway git repo as a fake /app via APP_DIR.
set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/setup-worktree.sh"
PASS=0; FAIL=0
assert() { # label, condition-exit
  if [ "$2" = "0" ]; then echo "PASS — $1"; PASS=$((PASS+1));
  else echo "FAIL — $1"; FAIL=$((FAIL+1)); fi
}

# Build a PreToolUse/Agent payload for a developer dispatch.
# args: subagent_type worktree_path branch_name task_id
payload() {
  printf '{"tool_input":{"subagent_type":"%s","prompt":"ROLE: %s\\nTASK_ID: %s\\nWORKTREE_PATH: %s\\nBRANCH_NAME: %s"}}' \
    "$1" "$1" "$4" "$2" "$3"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export APP_DIR="$TMP/app"
mkdir -p "$APP_DIR"
git -C "$APP_DIR" init -q -b main
git -C "$APP_DIR" config user.email t@t.t; git -C "$APP_DIR" config user.name t
echo seed > "$APP_DIR/seed.txt"; git -C "$APP_DIR" add .; git -C "$APP_DIR" commit -qm seed
mkdir -p "$APP_DIR/node_modules"

export CHAT_SESSION_DIR="$TMP/logs/ab12cd34-xxxx"
mkdir -p "$CHAT_SESSION_DIR"

WT1="$APP_DIR/worktrees/ab12cd34/TASK-001"

# Dispatch a COMPLEX developer for TASK-001 (PreToolUse/Agent format)
payload developer "$WT1" "ab12cd34/TASK-001" TASK-001 | bash "$HOOK" >/dev/null 2>&1

git -C "$APP_DIR" show-ref --verify --quiet refs/heads/session/ab12cd34; assert "session branch created" $?
git -C "$APP_DIR" show-ref --verify --quiet refs/heads/session-base/ab12cd34; assert "session-base anchor created" $?
test -d "$APP_DIR/worktrees/ab12cd34/_session"; assert "_session worktree created" $?
test -d "$WT1"; assert "task worktree created" $?
test -e "$WT1/node_modules"; assert "node_modules hard-linked into task worktree" $?
# Task branch must fork from the session branch, not main directly:
git -C "$APP_DIR" merge-base --is-ancestor session/ab12cd34 ab12cd34/TASK-001 2>/dev/null; assert "task branch forked from session branch" $?

# Non-dev dispatches (reviewer/merger/planner) must be a silent no-op.
printf '{"tool_input":{"subagent_type":"quality-reviewer","prompt":"ROLE: quality-reviewer\\nTASK_ID: TASK-001\\nWORKTREE_PATH: %s"}}' "$WT1" | bash "$HOOK" >/dev/null 2>&1
assert "non-dev dispatch exits 0" $?

# Restart scenario: a second identical dispatch must be a no-op (exit 0), keep worktree.
payload developer "$WT1" "ab12cd34/TASK-001" TASK-001 | bash "$HOOK" >/dev/null 2>&1
assert "idempotent second run exits 0" $?
test -d "$WT1"; assert "task worktree still present after idempotent run" $?

# Regression: session restart where the bind-mount/cleanup wiped the _session
# directory but git still holds the worktree registration. Plain `worktree add`
# fails with "missing but already registered"; the hook must prune + recreate.
rm -rf "$APP_DIR/worktrees/ab12cd34/_session"
git -C "$APP_DIR" worktree list --porcelain | grep -qF "worktrees/ab12cd34/_session"; assert "stale _session registration survives dir wipe" $?
payload developer "$APP_DIR/worktrees/ab12cd34/TASK-002" "ab12cd34/TASK-002" TASK-002 | bash "$HOOK" >/dev/null 2>&1
test -e "$APP_DIR/worktrees/ab12cd34/_session/.git"; assert "_session recreated after stale-registration wipe" $?
grep -q "SESSION-BRANCH FAILED" "$CHAT_SESSION_DIR/hooks.log" 2>/dev/null; assert "no SESSION-BRANCH FAILED logged" $([ $? -ne 0 ] && echo 0 || echo 1)

# A missing-identity payload (no WORKTREE_PATH) must not crash and must exit 0.
printf '{"tool_input":{"subagent_type":"developer","prompt":"ROLE: developer\\nTASK_ID: TASK-009"}}' | bash "$HOOK" >/dev/null 2>&1
assert "missing WORKTREE_PATH exits 0 (enforce-dev-dispatch blocks it separately)" $?

# SIMPLE parity: a simple-developer dispatch WITHOUT WORKTREE_PATH still gets the
# fixed <SHORT>/simple worktree (derived from CHAT_SESSION_DIR's session short).
printf '{"tool_input":{"subagent_type":"simple-developer","prompt":"ROLE: simple-developer\\nCHANGE_REQUEST: rename a button"}}' | bash "$HOOK" >/dev/null 2>&1
test -d "$APP_DIR/worktrees/ab12cd34/simple"; assert "simple worktree derived without WORKTREE_PATH in prompt" $?

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
