---
name: agent-team
description: Multi-agent team workflow for implementing tickets with peer-to-peer communication inside a single shared team. Used by chat-orchestrator for COMPLEX requests only (planner → wave → teardown). Single source of truth for cross-agent messaging.
---

# Agent Team — Single-team peer-to-peer workflow

Invoked by `chat-orchestrator` (team-lead) for COMPLEX requests.

**Runtime constraint:** one team per lead, no nested teams. So all members of a wave live in one shared team `tickets`, with deterministic suffixed names.

**Out of scope:** SIMPLE requests (1-file cosmetic). Those bypass this skill — orchestrator dispatches one developer agent without `team_name`.

---

## Wave of N tickets

A wave spans the initial user turn AND any number of background turns until the wave completes. The lead **alternates** between BUSY mode (in a tool call — protects active teammates from teardown) and YIELD mode (turn ended — lets the runtime schedule dormant teammates on unread inbox messages).

Each lead turn in the wave follows the pattern: `Bash(wait-for-team-merges.sh)` for 60 s → short status text → `end_turn` → wait for background turn → repeat. The 60 s Bash buys safety for mid-tool-call teammates; the immediate `end_turn` after it lets dormant teammates wake up.

1. PLANNER produces N tickets.
2. Lead `TeamCreate({team_name: "tickets"})` (once per wave).
3. Lead dispatches all members in ONE message: **N developers + 2N reviewers + 1 shared `merger` = 3N + 1**.
4. Lead `SendMessage(GO)` to each `developer-TASK-XXX` (one message per dev, in the initial user turn).
5. In the same initial turn: lead calls `Bash("/home/developer/.claude/hooks/wait-for-team-merges.sh N 0 tickets")` (60 s) → handles any new merger reports as user-facing text → emits a short status text → `end_turn`. This yields control back to the runtime so dormant teammates can be scheduled.
6. Each background turn (auto-fired when team-lead inbox gets a new message): lead reads incoming `<teammate-message>` blocks, calls `wait-for-team-merges.sh` again (with updated `LAST_COUNT`) → emits status text → `end_turn`. Loop until the script returns `done: true`.
7. When `done: true`: lead does Phase 3 teardown (shutdown_request batch + TeamDelete) and the final reply in the same turn, then `end_turn` for the last time.

Multi-wave: subsequent waves begin on the next user turn (the previous wave's `TeamDelete` already ran inside its terminal turn).

---

## Ticket composition (per ticket)

Every ticket in a wave gets the same trio:

- `developer-TASK-XXX`
- `quality-reviewer-TASK-XXX`
- `test-validator-TASK-XXX`

Plus one shared `merger` for the whole wave.

---

## Addressing (single team `tickets`, bare names)

| Recipient | `to:` value | Scope |
|---|---|---|
| Lead (orchestrator) | `team-lead` | singleton |
| Developer of ticket X | `developer-TASK-X` | per ticket |
| Quality reviewer of ticket X | `quality-reviewer-TASK-X` | per ticket |
| Test validator of ticket X | `test-validator-TASK-X` | per ticket |
| Merger | `merger` | **shared singleton across the wave** |

Rules:
- Suffixed peers only talk to their own `TASK-X` counterparts + shared `merger` + `team-lead`.
- Cross-ticket SendMessage between suffixed peers is forbidden.
- Shared `merger` only initiates to `team-lead` (merge reports).

Why one shared merger: `git merge` against `/app` holds `.git/index.lock`. Parallel mergers serialise on the lock anyway — single merger eliminates retry-on-lock complexity.

---

## Phase 1 — Dispatch (lead, ONE message)

Pre-condition: PLANNER produced N tickets.

In one assistant message:

```
TeamCreate({team_name: "tickets", description: "Wave of N tickets"})

// Per ticket (one trio per ticket, all in this same message):
Agent({subagent_type: "developer", name: "developer-TASK-001", team_name: "tickets", model: "opus", description: "Implement TASK-001", prompt: "<see Spawn prompt frames below>"})
Agent({subagent_type: "quality-reviewer", name: "quality-reviewer-TASK-001", team_name: "tickets", model: "sonnet", description: "Quality review TASK-001", prompt: "<see Spawn prompt frames below>"})
Agent({subagent_type: "test-validator", name: "test-validator-TASK-001", team_name: "tickets", model: "sonnet", description: "Test validation TASK-001", prompt: "<see Spawn prompt frames below>"})

// (... repeat trio for TASK-002, TASK-003, ...)

// ONE shared merger (last):
Agent({subagent_type: "merger", name: "merger", team_name: "tickets", model: "haiku", description: "Merge all tickets", prompt: "<see Spawn prompt frames below>"})
```

Then in a second message: one `SendMessage(GO, …)` per developer:

```
SendMessage({to: "developer-TASK-001", message: "GO — Implement TASK-001 (worktree=/app/worktrees/<SESSION_SHORT_ID>/TASK-001, branch=<SESSION_SHORT_ID>/<branch>). Ticket spec at <path>. COUNTERPARTS: reviewers=[quality-reviewer-TASK-001, test-validator-TASK-001], merger=merger."})
```

After GO: lead enters the **wait loop** described above (Bash-polled `wait-for-team-merges.sh`, still in the same assistant turn). The script counts merger reports (`merged TASK-XXX, commit=<sha>` or `TASK-XXX merge failed: <reason>`) directly from the team-lead inbox. When `done: true` (count == N) → Phase 3 in this same turn.

Bounds for the loop (the lead enforces them, the script doesn't):
- Hard cap **30 iterations** (~30 min). Past that, abort the wave: skip the shutdown batch, call `TeamDelete({})` once, report "stalled" to the user.
- 5 consecutive iterations with `timeout: true` and zero `new_reports` (5 min of total silence) → same abort path.

### Spawn prompt frames

The WORKFLOW for each role is defined in their own agent file (developer.md,
quality-reviewer.md, test-validator.md, merger.md). Spawn prompts only carry
the per-ticket inputs; agents read their own file for the workflow.

**developer-TASK-XXX**
```
ROLE: developer
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX
BRANCH_NAME: <SESSION_SHORT_ID>/feature/<branch>
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPARTS:
  - reviewers: [quality-reviewer-TASK-XXX, test-validator-TASK-XXX]
  - merger: merger   (shared singleton — bare name)
TEAM_LEAD: team-lead

Follow the WORKFLOW in your agent file (developer.md). Do NOT call
`Skill({skill: "agent-team"})` — that's for the team-lead, not you.
```

**quality-reviewer-TASK-XXX** and **test-validator-TASK-XXX** share the same frame:
```
ROLE: <quality-reviewer | test-validator>
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

Follow the WORKFLOW in your agent file. Do NOT call any tool until
`developer-TASK-XXX` sends you a "ready" message. Do NOT call
`Skill({skill: "agent-team"})`.
```

**merger** (singleton, no suffix):
```
ROLE: merger
NAME: merger   (no suffix — single shared merger for the whole wave)
TEAM: tickets
TICKETS_DIR: <session_dir>   (passed at spawn)
TEAM_LEAD: team-lead

Follow the WORKFLOW in your agent file (merger.md). Do NOT call any tool
until you receive a SendMessage from a developer-TASK-XXX. Do NOT call
`Skill({skill: "agent-team"})` — it's for the team-lead, not you.
```

---

## Phase 3 — Graceful teardown (lead, immediately after `done: true`)

Phase 3 runs **inside the same assistant turn** as Phase 1 and the wait loop. The lead does not yield between Phase 1 and Phase 3.

### 3a — SendMessage shutdown_request to every active member (ONE message)

```
SendMessage({to: "developer-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "quality-reviewer-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "test-validator-TASK-001", message: {type: "shutdown_request"}})
// ... (repeat trio per ticket)
SendMessage({to: "merger", message: {type: "shutdown_request"}})   // last
```

Total: `3N + 1` SendMessages.

### 3b — TeamDelete

```
TeamDelete({})
```

`{}` = "the only team this session has open". `teamdelete-gate.sh` may briefly block if `shutdown_approved` hasn't been recorded yet — if blocked, the lead runs `Bash("sleep 3")` and retries once. If it still fails, the lead ignores the error: `teamdelete-cleanup.sh` (PostToolUse) cleans residual `~/.claude/teams/tickets/` regardless.

Subagent transcripts (`subagents/agent-<task_id>.{jsonl,meta.json}`) are kept for stats/debugging — removed at chat-service session end.

### 3c — Final reply

Reply to user, one line per ticket (translated, business language):
- Success: e.g. "Sessions feature done."
- Failure: e.g. "Hit a snag on the sessions piece — sorted the rest."

After this user-facing text, this is the **first** `end_turn` of the lead since the wave started. The wave is done.

If next wave: it starts on the next user turn (Phase 4). Else end.

---

## Phase 4 — Multi-wave

Some tickets depend on others. PLANNER groups them into waves.

After Phase 3 completes for wave 1 (TeamDelete already ran inside that turn), the lead yields its `end_turn` with the recap reply. On the **next** user turn, the lead recomputes deps and starts a new Phase 1 for wave 2 — same `tickets` team_name (the previous one was deleted), new dispatches, new wait loop.

If the lead capped Step 1 at 5 of N>5 tickets for the current wave, the leftover tickets are treated as the next wave on the next turn — same mechanism.

Stop when no pending tickets remain.

---

## Failure paths

| Scenario | Detected by | Reaction |
|---|---|---|
| Reviewer silent > 180s | dev (timeout) | dev → team-lead "TASK-XXX stuck on <reviewer>". Lead's wait loop sees no new merger report; if 5 min of total silence elapses, the lead aborts the wave. |
| Dev fix-cycle > 5 | dev (counter) | dev → team-lead "TASK-XXX stuck: <N> cycles". Same recovery path as above. |
| Merger merge conflict | merger | merger → team-lead "TASK-XXX merge failed: <reason>". This *counts* as a merger report in the wait loop → wave can complete with a failure on this ticket. |
| Wave stalled silently (no merger reports in 5+ min) | lead (5 consecutive `timeout: true` from `wait-for-team-merges.sh`) | Lead aborts wave: skip shutdown batch, single `TeamDelete({})`, reply to user "stalled". |
| Wave never completes (30 iterations / ~30 min cap) | lead (iteration counter) | Same abort path as above. |
| Hook `stop-hook-error` | system event in lead's stream | Lead reads, decides. Validation crash → "validation skipped", warn user. |
| User STOP | chat-service `cancelled` | chat-service does brutal cleanup of `subagents/*`, doesn't wait for lead. |

### Per-ticket abort

If one ticket fails but others are healthy — abort only its trio. **Never** shut down the shared `merger` (others still need it).

```
SendMessage({to: "developer-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
SendMessage({to: "quality-reviewer-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
SendMessage({to: "test-validator-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
// yield, verify shutdown_approved from these 3 only.
// Do NOT TeamDelete. Do NOT shutdown merger.
```

Mark TASK-001 failed in `${TICKETS_DIR}/TASK-001.json`. Other tickets keep going. When the wave's remaining tickets all merged, do standard Phase 3 (already-stopped members are skipped, shared merger goes last).

### Wave abort (full)

Same protocol as Phase 3 (3a→3d), but tag every shutdown_request with `reason: "ABORT"`. Worktrees are left intact for manual recovery.
