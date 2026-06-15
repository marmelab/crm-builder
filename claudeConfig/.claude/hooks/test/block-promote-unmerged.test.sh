#!/bin/bash
# Tests for block-promote-unmerged.sh — the no-team promotion guard.
# Builds a throwaway repo with a session branch + one merged and one unmerged
# task branch, then exercises the hook with PreToolUse/Agent payloads.
set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/block-promote-unmerged.sh"
PASS=0; FAIL=0
assert() { # label, actual-exit, expected-exit
  if [ "$2" = "$3" ]; then echo "PASS — $1 (exit $2)"; PASS=$((PASS+1));
  else echo "FAIL — $1 (got $2, want $3)"; FAIL=$((FAIL+1)); fi
}
run() { printf '%s' "$1" | bash "$HOOK" >/dev/null 2>&1; echo $?; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export APP_DIR="$TMP/app"; mkdir -p "$APP_DIR"
export CHAT_SESSION_DIR="$TMP/logs/ab12cd34-xxxx"; mkdir -p "$CHAT_SESSION_DIR"
G() { git -C "$APP_DIR" "$@"; }
G init -q -b main; G config user.email t@t.t; G config user.name t
echo seed > "$APP_DIR/seed.txt"; G add .; G commit -qm seed
G branch session/ab12cd34 main
G branch session-base/ab12cd34 main

# --- a MERGED task branch (commits already on the session branch) ---
G checkout -q -b ab12cd34/TASK-001 session/ab12cd34
echo a > "$APP_DIR/a.txt"; G add .; G commit -qm "feat(TASK-001): work"
G checkout -q session/ab12cd34
G merge -q --no-ff ab12cd34/TASK-001 -m "merge(TASK-001)"
G checkout -q main

PROMOTE='{"agent_type":"","tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nMODE: promote\nSESSION_SHORT_ID: ab12cd34"}}'

# All task branches merged → promotion allowed.
assert "promote allowed when all task branches merged" "$(run "$PROMOTE")" 0

# --- an UNMERGED task branch (committed but never merged into session) ---
G checkout -q -b ab12cd34/TASK-002 session/ab12cd34
echo b > "$APP_DIR/b.txt"; G add .; G commit -qm "feat(TASK-002): work"
G checkout -q main

# Promotion must now be refused (the TASK-002 case).
assert "promote BLOCKED when a task branch is unmerged" "$(run "$PROMOTE")" 2

# A per-ticket merger (no MODE: promote) must NOT be gated, even with unmerged work.
PERTICKET='{"agent_type":"","tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nTASK_ID: TASK-002\nBRANCH_NAME: ab12cd34/TASK-002\nSESSION_SHORT_ID: ab12cd34"}}'
assert "per-ticket merger not gated" "$(run "$PERTICKET")" 0

# A developer dispatch must pass through untouched.
DEV='{"agent_type":"","tool_input":{"subagent_type":"developer","prompt":"ROLE: developer\nTASK_ID: TASK-003\nWORKTREE_PATH: /app/worktrees/ab12cd34/TASK-003\nBRANCH_NAME: ab12cd34/TASK-003"}}'
assert "developer dispatch not gated" "$(run "$DEV")" 0

# A subagent (non-empty agent_type) calling must be ignored even on a promote prompt.
SUBPROMOTE='{"agent_type":"merger","tool_input":{"subagent_type":"merger","prompt":"ROLE: merger\nMODE: promote\nSESSION_SHORT_ID: ab12cd34"}}'
assert "subagent-issued promote not gated (orchestrator-only)" "$(run "$SUBPROMOTE")" 0

# Once TASK-002 is merged, promotion is allowed again.
G checkout -q session/ab12cd34
G merge -q --no-ff ab12cd34/TASK-002 -m "merge(TASK-002)"
G checkout -q main
assert "promote allowed again after TASK-002 merged" "$(run "$PROMOTE")" 0

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
