# SIMPLE flow — merger reliability fixes

**Date**: 2026-05-29
**Branch**: fix/Supabasemode
**Scope**: `claudeConfig/.claude/agents/chat-orchestrator.md` only

---

## Context

Observed in session `58b2455f` ("Add importance field to deals"). The SIMPLE + POST-DEV flow produced:
- 3 merger agents spawned (1 blocked, 1 S-MERGE success, 1 PD-MIG-MERGE)
- 2 migration quality-reviewers spawned on the same turn
- Both `TASK-SIMPLE-*.json` tickets left at `"in_progress"` after session end

---

## Root causes

### Bug 1+2 — Merger blocked by member-idle-gate → retry

`member-idle-gate.sh` detects SIMPLE flow by checking whether the merger's first
tool call contains `/worktrees/<SESSION_SHORT>/simple` in its `tool_input`. If the
orchestrator omits `WORKTREE_PATH` from the merger spawn prompt, the first call
is something generic (e.g. a git log) → path not found → hook blocks with
"Cannot determine TASK_ID for agent 'merger'" → orchestrator retries.

### Bug 3 — Duplicate migration reviewers

STATE PD-MIG-REVIEW instruction says "Dispatch ONE quality-reviewer" but doesn't
explicitly forbid dispatching two Agent calls on the same turn. The model dispatched
both simultaneously.

### Bug 4 — Ticket status stuck at "in_progress"

The SIMPLE merger prompt template (both STATE S-MERGE and STATE PD-MIG-MERGE) does
not include `TICKETS_DIR`. The merger's Step 3 does `ls ${TICKETS_DIR}/TASK-SIMPLE-*.json`
but `TICKETS_DIR` is undefined in its prompt → glob fails silently → status never
updated.

---

## Design

### Fix 1+2 — Pre-write the merger flag before dispatch (STATE S-MERGE)

Add one `Bash` call immediately before the `Agent({subagent_type: "merger", ...})`
dispatch in STATE S-MERGE:

```
Bash("touch /tmp/notified-merger-<SESSION_SHORT_ID>-simple")
```

`/tmp/notified-merger-SHORT-simple` is the exact flag the hook checks first (before
the IS_SIMPLE tool_input scan). Pre-writing it decouples the bypass entirely from the
content of the merger's first tool call.

The flag also covers PD-MIG-MERGE (same session, same flag name) → no additional
change needed in STATE PD-MIG-MERGE.

### Fix 3 — ONE Agent call constraint (STATE PD-MIG-REVIEW)

Prepend to the dispatch instruction:

> "CRITICAL: ONE Agent call only. Dispatch once, end the turn, wait for the result."

### Fix 4 — Pass TICKETS_DIR to the SIMPLE merger (STATE S-MERGE + STATE PD-MIG-MERGE)

Add `TICKETS_DIR: <absolute path>` to the SIMPLE merger prompt template in both states.
The merger already has the Step 3 glob logic — it just needs the value.

---

## Files changed

| File | States touched |
|------|---------------|
| `claudeConfig/.claude/agents/chat-orchestrator.md` | STATE S-MERGE, STATE PD-MIG-REVIEW, STATE PD-MIG-MERGE |

No hook changes. No agent file changes.

---

## Expected outcome after fix

| Before | After |
|--------|-------|
| 3 merger agents (1 blocked + 2) | 2 merger agents (S-MERGE + PD-MIG-MERGE) |
| First merger blocked by idle-gate | First merger passes immediately |
| 2 quality-reviewers on same turn | 1 quality-reviewer per turn |
| Tickets stay "in_progress" | Tickets updated to "merged" by PD-MIG-MERGE merger |
