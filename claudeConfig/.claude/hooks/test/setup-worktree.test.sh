#!/bin/bash
# Tests for setup-worktree.sh session-branch topology.
# Uses a throwaway git repo as a fake /app via APP_DIR override.
set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/setup-worktree.sh"
PASS=0; FAIL=0
assert() { # label, condition-exit
  if [ "$2" = "0" ]; then echo "PASS — $1"; PASS=$((PASS+1));
  else echo "FAIL — $1"; FAIL=$((FAIL+1)); fi
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

# Dispatch a COMPLEX developer for TASK-001
echo '{"agent_type":"developer-TASK-001"}' | bash "$HOOK" >/dev/null 2>&1

git -C "$APP_DIR" show-ref --verify --quiet refs/heads/session/ab12cd34; assert "session branch created" $?
git -C "$APP_DIR" show-ref --verify --quiet refs/heads/session-base/ab12cd34; assert "session-base anchor created" $?
test -d "$APP_DIR/worktrees/ab12cd34/_session"; assert "_session worktree created" $?
test -d "$APP_DIR/worktrees/ab12cd34/TASK-001"; assert "task worktree created" $?
# Task branch must fork from the session branch, not main directly:
git -C "$APP_DIR" merge-base --is-ancestor session/ab12cd34 ab12cd34/TASK-001 2>/dev/null; assert "task branch forked from session branch" $?

# Restart scenario: a second dispatch with the same session must be a no-op (exit 0).
echo '{"agent_type":"developer-TASK-001"}' | bash "$HOOK" >/dev/null 2>&1
assert "idempotent second run exits 0" $?

# Regression: session restart where the bind-mount/cleanup wiped the _session
# directory but git still holds the worktree registration. Plain `worktree add`
# fails with "missing but already registered"; the hook must prune + recreate.
rm -rf "$APP_DIR/worktrees/ab12cd34/_session"
git -C "$APP_DIR" worktree list --porcelain | grep -qF "worktrees/ab12cd34/_session"; assert "stale _session registration survives dir wipe" $?
echo '{"agent_type":"developer-TASK-002"}' | bash "$HOOK" >/dev/null 2>&1
test -e "$APP_DIR/worktrees/ab12cd34/_session/.git"; assert "_session recreated after stale-registration wipe" $?
grep -q "SESSION-BRANCH FAILED" "$CHAT_SESSION_DIR/hooks.log" 2>/dev/null; assert "no SESSION-BRANCH FAILED logged" $([ $? -ne 0 ] && echo 0 || echo 1)

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
