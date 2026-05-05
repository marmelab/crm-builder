---
name: agent-team
description: Multi-agent team workflow for implementing tickets with peer-to-peer communication inside a single shared team. Used by chat-orchestrator for COMPLEX requests only (planner → wave → teardown). Single source of truth for cross-agent messaging.
---

# Agent Team — Single-team peer-to-peer workflow

Invoked by `chat-orchestrator` (team-lead) for COMPLEX requests, and read by every member at startup.

**Runtime constraint:** one team per lead, no nested teams. So all members of a wave live in one shared team `tickets`, with deterministic suffixed names.

**Out of scope:** SIMPLE requests (1-file cosmetic). Those bypass this skill — orchestrator dispatches one developer agent without `team_name`.

---

## TL;DR — for a wave of N tickets

1. PLANNER produces N tickets.
2. Lead `TeamCreate({team_name: "tickets"})` (once per wave).
3. Lead dispatches all members in ONE message: **N developers + 2N reviewers + 1 shared `merger` = 3N + 1**.
4. Lead `SendMessage(GO)` to each `developer-TASK-XXX` (one message per dev, in one assistant turn).
5. Lead enters passive wait. Each ticket's dev↔reviewers↔merger flow runs concurrently inside `tickets`.
6. When merger has reported N times, lead does Phase 3 teardown.

Multi-wave: repeat 2→6 (TeamDelete then TeamCreate again).

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
Agent({subagent_type: "developer", name: "developer-TASK-001", team_name: "tickets", model: "opus", description: "Implement TASK-001", prompt: "<see Phase 2 — developer>"})
Agent({subagent_type: "quality-reviewer", name: "quality-reviewer-TASK-001", team_name: "tickets", model: "sonnet", description: "Quality review TASK-001", prompt: "<see Phase 2 — quality-reviewer>"})
Agent({subagent_type: "test-validator", name: "test-validator-TASK-001", team_name: "tickets", model: "sonnet", description: "Test validation TASK-001", prompt: "<see Phase 2 — test-validator>"})

// (... repeat trio for TASK-002, TASK-003, ...)

// ONE shared merger (last):
Agent({subagent_type: "merger", name: "merger", team_name: "tickets", model: "haiku", description: "Merge all tickets", prompt: "<see Phase 2 — merger>"})
```

Then in a second message: one `SendMessage(GO, …)` per developer:

```
SendMessage({to: "developer-TASK-001", message: "GO — Implement TASK-001 (worktree=/app/worktrees/TASK-001, branch=<branch>). Ticket spec at <path>. COUNTERPARTS: reviewers=[quality-reviewer-TASK-001, test-validator-TASK-001], merger=merger."})
```

After GO: lead enters **passive wait**. It receives N final SendMessages from `merger` (one per ticket: `merged TASK-XXX, commit=<sha>` or `TASK-XXX merge failed: <reason>`). When count == N → Phase 3.

---

## Phase 2 — Per-agent protocols

Each protocol is the spawn prompt, parametrised by `TASK_ID` and `COUNTERPARTS`.

### developer

The per-cycle WORKFLOW (read → implement → request review → handle verdicts
→ reflection → hand off to merger) lives in the `developer-protocol` skill,
auto-loaded via the developer agent's frontmatter. The dispatch prompt only
sets up the inputs.

```
ROLE: developer
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /app/worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPARTS:
  - reviewers: [quality-reviewer-TASK-XXX, test-validator-TASK-XXX]
  - merger: merger   (shared singleton — bare name)
TEAM_LEAD: team-lead

Apply the WORKFLOW + TIMEOUTS from the developer-protocol skill (already in
your context). Do NOT call `Skill({skill: "agent-team"})` — that's for the
team-lead, not you.
```

### quality-reviewer

The per-cycle workflow (idle on dispatch → wait for dev's `"ready"` → review →
verdict → loop) lives in the `quality-review-protocol` skill, auto-loaded via
the agent's frontmatter. The dispatch prompt only sets up the inputs.

```
ROLE: quality-reviewer
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /app/worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

Apply the WORKFLOW from the quality-review-protocol skill (already in your
context). The detailed review rubric (Parts A and B) is in your agent's own
prompt. Do NOT call `Skill({skill: "agent-team"})` — that's for the team-lead.
```

### test-validator

The per-cycle workflow (idle on dispatch → wait for dev's `"ready"` → validate
→ verdict → loop) lives in the `test-validation-protocol` skill, auto-loaded
via the agent's frontmatter. The dispatch prompt only sets up the inputs.

```
ROLE: test-validator
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /app/worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

Apply the WORKFLOW from the test-validation-protocol skill (already in your
context). Step 1/2/3 detail and the verdict matrix are in your agent's own
prompt. Do NOT call `Skill({skill: "agent-team"})` — that's for the team-lead.
```

### merger (shared singleton)

The MERGE STEPS themselves live in the `merge-protocol` skill, which is
auto-loaded via the merger agent's frontmatter. The dispatch prompt only
needs to wire up the team flow — message routing, looping, shutdown — not
re-spell the merge procedure.

```
ROLE: merger
NAME: merger   (no suffix — single shared merger for the whole wave)
TEAM: tickets
TICKETS_DIR: <session_dir>   (passed at spawn)
TEAM_LEAD: team-lead

INITIAL ACTION ON DISPATCH:
**Stop immediately. Do NOT call any tool — including Skill. Idle until you
receive your first SendMessage from a `developer-TASK-XXX`.** Your spawn
context already has the merge-protocol skill loaded; do NOT call
`Skill({skill: "agent-team"})` — it's for the team-lead, not you.

WORKFLOW (loop until shutdown_request):
Each incoming message from a developer-TASK-XXX MUST start with
"ready: TASK-XXX, branch=<branch>". Process them serially (git lock makes it
serial anyway).

For each incoming message:
1. Parse from: → derive TASK_ID (e.g. from="developer-TASK-006" → "TASK-006").
2. Parse "branch=<branch>" (fallback: read ${TICKETS_DIR}/TASK-XXX.json,
   pick branch_name).
3. WORKTREE_PATH = /app/worktrees/TASK-XXX.
4. Run the MERGE STEPS from the merge-protocol skill (already in your
   context). Use the COMPLEX-mode branches at steps 5 (update ticket) and
   6 (SendMessage report to team-lead).
5. Idle for the next message — do NOT stop after one merge.
6. On SendMessage(shutdown_request): reply shutdown_approved and stop.

If unexpected sender or malformed message:
SendMessage(team-lead, "merger received unexpected from <from>: <quote>")
and idle.
```

---

## Phase 3 — Graceful teardown (lead, when merger reported N times)

### 3a — SendMessage shutdown_request to every active member (ONE message)

```
SendMessage({to: "developer-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "quality-reviewer-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "test-validator-TASK-001", message: {type: "shutdown_request"}})
// ... (repeat trio per ticket)
SendMessage({to: "merger", message: {type: "shutdown_request"}})   // last
```

Total: `3N + 1` SendMessages.

### 3b — Yield the turn

Emit a brief assistant text (e.g. *"Wrapping up..."*) and stop. **No other tool calls.** The runtime delivers `shutdown_approved` on the next user turn — being read in the lead's stream marks them read, preventing embryos.

### 3c — Verify on next turn

Scan incoming `<teammate-message>` blocks for `shutdown_approved`:
- ✅ All approved → 3d.
- ❌ One missing after ~10s → log "member <name> didn't acknowledge — proceeding". Investigate post-hoc via `/home/developer/.claude/projects/-app/$CLAUDE_SESSION_ID/subagents/agent-<task_id>.jsonl`.

### 3d — TeamDelete

```
TeamDelete({})
```

`{}` = "the only team this session has open". `teamdelete-gate.sh` blocks if any non-lead member hasn't acknowledged. If blocked: yield first, retry next turn — do not retry in same turn.

### 3e — Cleanup (automatic)

`teamdelete-cleanup.sh` (PostToolUse) silently removes residual `~/.claude/teams/tickets/`. Lead does nothing.

Subagent transcripts (`subagents/agent-<task_id>.{jsonl,meta.json}`) are kept for stats/debugging — removed at chat-service session end.

### After cleanup

Reply to user, one line per ticket:
- Success: "TASK-XXX done, merge commit `<sha>`."
- Failure: "TASK-XXX failed: `<reason>`. Branch retained at `<branch>`."

If next wave: go to Phase 4. Else end.

---

## Phase 4 — Multi-wave

Some tickets depend on others. PLANNER groups them into waves.

After Phase 3 completes for wave 1: recompute deps, start a new Phase 1 for wave 2 — same `tickets` team_name (previous was deleted), new dispatches.

TeamDelete is mandatory between waves.

Stop when no pending tickets remain.

---

## Failure paths

| Scenario | Detected by | Reaction |
|---|---|---|
| Reviewer silent > 180s | dev (timeout) | dev → team-lead "TASK-XXX stuck on <reviewer>". Lead pings or aborts ticket. |
| Dev fix-cycle > 5 | dev (counter) | dev → team-lead "TASK-XXX stuck: <N> cycles". Lead reformulates or aborts. |
| Merger merge conflict | merger | merger → team-lead "TASK-XXX merge failed: <reason>". Lead resumes dev or marks failed. |
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
