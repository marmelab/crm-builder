---
name: agent-team
description: Multi-agent team workflow for implementing tickets with peer-to-peer communication inside a single shared team. Use when dispatching agents or following the full lifecycle (bootstrap → planning → wave-of-tickets in one team → teardown). This skill is the single source of truth for how the team communicates.
---

# Agent Team — Single-team peer-to-peer workflow

This skill is invoked by `chat-orchestrator` (team-lead role) and by every team member at startup. It describes the full lifecycle and every cross-agent message.

**Architectural constraint** (runtime, documented at https://code.claude.com/docs/en/agent-teams under "Limitations"): *one team per lead at a time, no nested teams.* The skill therefore puts **all** ticket-pair members of a wave into one shared team named `tickets`, with deterministic per-ticket naming so each pair (developer + reviewers + merger for one ticket) communicates only with itself.

## TL;DR

For a wave of N tickets:

1. PLANNER produces tickets.
2. Lead `TeamCreate({team_name: "tickets"})` (single team, once per wave).
3. Lead dispatches **all 4×N members in ONE assistant message**, with names suffixed by ticket id (`developer-TASK-001`, `quality-reviewer-TASK-001`, …).
4. Lead `SendMessage` GO to each `developer-TASK-XXX` (in ONE message).
5. Lead enters passive wait. Each ticket's developer ↔ reviewers ↔ merger conversation runs concurrently inside `tickets`, isolated by name.
6. When every merger has reported back, lead does Phase 3 graceful teardown of the whole team in one shot. Hooks handle the residual cleanup.

If the planner produces multiple waves, repeat 2→6 per wave (TeamDelete then TeamCreate again with the same `tickets` name).

## When to use

- Lead (chat-orchestrator): after classifying the user request as a code change.
- Each team member: at the start of their first activation, to know the protocol.

## Modes (per ticket, not per wave)

A wave can mix simple-mode tickets and complex-mode tickets — each ticket carries its own mode flag.

- **Simple mode (per ticket):** `developer-TASK-XXX` + `merger-TASK-XXX` (2 agents). No reviewers, no Mode 2 reflection. Used for one-shot UI tweaks ("rename label X to Y", "hide button Z"), single-file edits, no test impact.
- **Complex mode (per ticket):** `developer-TASK-XXX` + `quality-reviewer-TASK-XXX` + `test-validator-TASK-XXX` + `merger-TASK-XXX` (4 agents). Mode 2 reflection between all-APPROVED and SendMessage merger. Used for multi-file features, anything touching data flow, anything affecting tests, anything ambiguous.

The lead classifies each ticket in its planning turn. Default for ambiguous tickets is **complex** (false positives are cheap, missed reviews are not).

## SendMessage addressing — deterministic suffixed names

All members live in the single `tickets` team. The runtime's `SendMessage` accepts a bare name (no `@team` suffix needed, since there is exactly one team in scope). The "name" is the deterministic identity assigned via the `Agent` tool's `name:` parameter.

| Recipient | `to:` value |
|---|---|
| The lead (orchestrator) | `team-lead` |
| Developer of ticket X | `developer-TASK-X` |
| Quality reviewer of ticket X | `quality-reviewer-TASK-X` |
| Test validator of ticket X | `test-validator-TASK-X` |
| Merger of ticket X | `merger-TASK-X` |

A ticket-X member only ever talks to its own counterparts (suffix `-TASK-X`) and to `team-lead`. Cross-ticket SendMessage (e.g. `developer-TASK-001` → `quality-reviewer-TASK-002`) is forbidden — it indicates the prompt template was misapplied.

## Phase 1 — Team setup (lead only, once per wave)

Pre-condition: PLANNER has produced N tickets for this wave (TASK-001, TASK-002, ...). Each ticket has a `mode` field (`simple` or `complex`).

The lead does this in ONE assistant message — one tool_use block per agent, plus the TeamCreate, all in parallel:

```
TeamCreate({team_name: "tickets", description: "Wave of N tickets: TASK-001, TASK-002, ..."})

// For ticket TASK-001 (complex mode example):
Agent({
  subagent_type: "developer",
  name: "developer-TASK-001",
  team_name: "tickets",
  model: "opus",
  description: "Implement TASK-001",
  prompt: "<see Phase 2 — developer protocol>"  // includes COUNTERPARTS list
})

Agent({
  subagent_type: "quality-reviewer",
  name: "quality-reviewer-TASK-001",
  team_name: "tickets",
  model: "sonnet",
  description: "Quality review TASK-001",
  prompt: "<see Phase 2 — quality-reviewer protocol>"
})

Agent({
  subagent_type: "test-validator",
  name: "test-validator-TASK-001",
  team_name: "tickets",
  model: "sonnet",
  description: "Test validation TASK-001",
  prompt: "<see Phase 2 — test-validator protocol>"
})

Agent({
  subagent_type: "merger",
  name: "merger-TASK-001",
  team_name: "tickets",
  model: "haiku",
  description: "Merge TASK-001",
  prompt: "<see Phase 2 — merger protocol>"
})

// (... repeat the 4 dispatches for TASK-002, TASK-003, ... in the SAME message)
```

For simple-mode tickets, dispatch only `developer-TASK-XXX` and `merger-TASK-XXX` (skip the two reviewers).

After all spawns return successfully, the lead emits **one second assistant message** containing one SendMessage GO per developer:

```
SendMessage({
  to: "developer-TASK-001",
  message: "GO — Implement TASK-001 (worktree=/worktrees/TASK-001, branch=<ticket.branch_name>, mode=complex). Ticket spec at <ticket file path>. COUNTERPARTS: reviewers=[quality-reviewer-TASK-001, test-validator-TASK-001], merger=merger-TASK-001."
})
SendMessage({
  to: "developer-TASK-002",
  message: "GO — Implement TASK-002 (...). COUNTERPARTS: ..."
})
// (one per ticket, all in the same assistant message)
```

After SendMessage(GO, …), the lead enters **passive wait**. It receives one final SendMessage from each `merger-TASK-XXX` reporting "merged X" or "merge failed: <reason>".

## Phase 2 — Per-agent protocols

Each agent's prompt (sent at spawn) includes their role-specific protocol, parametrised by `TASK_ID` and `COUNTERPARTS`. Substitute `TASK_ID` with the actual ticket id (e.g. `TASK-001`) and fill in the counterpart names accordingly.

### developer

```
ROLE: developer
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json (complex) or <inline> (simple)
COUNTERPARTS:
  - reviewers: [quality-reviewer-TASK-XXX, test-validator-TASK-XXX]   (complex mode only)
  - merger: merger-TASK-XXX
TEAM_LEAD: team-lead

WORKFLOW:
1. Read the ticket spec.
2. Implement in the worktree (Edit/Write/Bash). Commit when ready.
3. (complex mode) SendMessage(to: "quality-reviewer-TASK-XXX", "ready, please review").
   SendMessage(to: "test-validator-TASK-XXX", "ready, please validate").
   Initialize approvals_needed=2, approvals_received=0.
4. (simple mode) Skip step 3. Go to step 7 directly.
5. Wait for replies from your reviewers (counterpart-suffixed names only). For each:
   - "APPROVED" → approvals_received++
   - "BLOCKED: ..." → reset approvals_received=0, apply the fixes, commit, then re-notify ALL reviewers (including those that previously APPROVED — the diff changed). Loop step 5.
6. When approvals_received == approvals_needed:
   - Switch to Mode 2 (reflection): read /app/docs/reflections/, write /worktrees/TASK-XXX/docs/reflections/TASK-XXX-reflection.md, commit.
7. SendMessage(to: "merger-TASK-XXX", "ready: all approved + reflection committed" (or "ready: simple mode" in simple)).
8. After SendMessage(merger-TASK-XXX), stop. Lead handles cleanup.

TIMEOUTS:
- If a reviewer doesn't reply within 180s, SendMessage(to: "team-lead", "TASK-XXX stuck on <reviewer>: no reply for 180s").
- If the same fix-cycle has run >5 times without convergence, SendMessage(to: "team-lead", "TASK-XXX stuck: <N> cycles, can't satisfy <reviewer>").
```

### quality-reviewer

```
ROLE: quality-reviewer
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

WORKFLOW (per incoming SendMessage from developer-TASK-XXX):
1. Read the ticket and the worktree diff (`git -C /worktrees/TASK-XXX diff <base>..HEAD`).
2. Apply the rules from .claude/rules/coding-style.md and .claude/rules/agent-output-format.md. Skim .claude/rules/security-triggers.md for anything that warrants security flagging.
3. Verdict:
   - All clear → SendMessage(to: "developer-TASK-XXX", "APPROVED")
   - Issues to fix → SendMessage(to: "developer-TASK-XXX", "BLOCKED:\n- file: ...\n  line: ...\n  description: ...\n  fix: ...\n- ...\nSummary: N blocking issues.")
4. After SendMessage, stop. Wait for next incoming message (re-review after dev's fix).

DO NOT:
- Run validations (typecheck, e2e, etc.) — those are handled by the PreToolUse hook on the dev side.
- SendMessage anyone other than developer-TASK-XXX (your own counterpart). You don't talk to other reviewers, you don't talk to merger, you don't talk to other tickets' agents.
- Re-spawn agents or call TeamCreate/TeamDelete.
```

### test-validator

```
ROLE: test-validator
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

WORKFLOW (per incoming SendMessage from developer-TASK-XXX):
1. Read the ticket and the worktree.
2. Verify TEST PRESENCE: every new behavior in the diff has at least one corresponding test (unit or e2e per .claude/rules/testing.md).
3. Verify TEST PERTINENCE: judge whether the assertions actually cover the failure modes that matter. A test that always passes (e.g. asserting truthy on a literal) is not pertinent.
4. Read .claude/skills/e2e-conventions to know when an e2e is required.
5. Verdict (same format as quality-reviewer):
   - SendMessage(to: "developer-TASK-XXX", "APPROVED") if presence + pertinence both OK
   - SendMessage(to: "developer-TASK-XXX", "BLOCKED:\n- ...") otherwise

DO NOT:
- Run the tests (the PreToolUse hook does that on the dev side). Your job is reading + judging coverage and pertinence, not running.
- SendMessage other reviewers, the merger, or any other ticket's agents.
```

### merger

```
ROLE: merger
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /worktrees/TASK-XXX
BRANCH: <ticket.branch_name>
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

WORKFLOW (per incoming SendMessage):
- If sender is developer-TASK-XXX and message is "ready" → proceed.
- Anything else → SendMessage(to: "team-lead", "merger-TASK-XXX received unexpected message: <quote>") and stop.

MERGE STEPS:
1. cd /app && git fetch
2. git checkout <base branch> && git pull --ff-only (or document if no remote)
3. git reset --hard HEAD ; /entrypoint-helpers/apply-app-variant.sh (re-applies App.tsx variant)
4. git merge --no-ff <ticket.branch_name> -m "chore(TASK-XXX): merge"
5. If merge succeeds: git worktree remove /worktrees/TASK-XXX ; git branch -d <ticket.branch_name>
6. SendMessage(to: "team-lead", "merged TASK-XXX, commit=<short sha>")
7. If merge fails (conflict, hook block, etc.): SendMessage(to: "team-lead", "TASK-XXX merge failed: <reason>") and stop.

CRITICAL — what merger NEVER does:
- `git add` / `git commit` of any file (only git merge + git reset --hard HEAD on /app are allowed; see CLAUDE.md "Merger never fabricates commits")
- Spawn agents, TeamCreate, TeamDelete
- Edit any file in /app or worktree (validation already done upstream by hooks)
- Talk to any other ticket's agents
```

## Phase 3 — Graceful team shutdown (lead only, once per wave)

When the lead has received `SendMessage(to: "team-lead", "merged X")` (or `"merge failed: ..."`) from **every** merger of the wave, the workflow for that wave is done but the agents' OS processes may still be alive (the runtime keeps them around for graceful termination). A clean shutdown drains all messages so no unread "embryos" survive on disk.

### Step 3a — SendMessage shutdown_request to every active member

In ONE assistant message, send a shutdown_request to **every** non-lead member of the team (every developer, every reviewer, every merger). For a wave of N complex tickets, that is 4×N SendMessages in one message:

```
SendMessage({to: "developer-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "quality-reviewer-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "test-validator-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "merger-TASK-001", message: {type: "shutdown_request"}})
SendMessage({to: "developer-TASK-002", message: {type: "shutdown_request"}})
// ...
```

For simple-mode tickets, only 2 SendMessages per ticket (developer + merger).

### Step 3b — Yield the turn so replies are delivered

Emit a brief assistant text (e.g. *"Wrapping up the wave…"*) and stop. The runtime delivers each member's `shutdown_approved` reply on the **next** user turn as a `<teammate-message>` block. Receiving them in the lead's turn-stream marks them **read**, so they will not become embryos. **Do not call any other tool in this turn — yielding is what lets the runtime deliver the replies.**

### Step 3c — Verify each member acknowledged

On the next turn, scan the incoming `<teammate-message>` blocks for `shutdown_approved` from every member you requested:

- ✅ All approved → proceed to Step 3d.
- ❌ One or more missing after ~10s of yielded waiting → log a brief message to the user (e.g. *"member &lt;name&gt; didn't acknowledge shutdown — proceeding anyway"*) and proceed; investigation can happen post-hoc by reading the member's transcript at `/home/developer/.claude/projects/-app/$CLAUDE_SESSION_ID/subagents/agent-<task_id>.jsonl`.

### Step 3d — TeamDelete

```
TeamDelete({})
```

`{}` (no input) is accepted and means "the only team this session has open". Since the lead is in the single `tickets` team, this is correct. The call releases the runtime's in-memory team registration.

> **Hook enforcement.** A `PreToolUse` hook (`teamdelete-gate.sh`) blocks TeamDelete if any non-lead member has not been fully shut down (no `shutdown_approved` from them in the lead's inbox, or one is present but unread). If you see *"TeamDelete blocked: N teammate(s) ... have not been gracefully shut down"*, follow the steps the hook lists and **do not retry TeamDelete in the same turn** — that will fail identically. Yield first, then retry on the next turn.

### Step 3e — automated cleanup (no action required)

A `PostToolUse` hook (`teamdelete-cleanup.sh`) runs after every successful `TeamDelete` and removes the residual team directory `~/.claude/teams/tickets/` (the runtime leaves behind `inboxes/` and other artifacts). The lead has nothing to do for this step — the hook is silent and runs in the background.

### What is intentionally NOT cleaned

Subagent transcripts (`/home/developer/.claude/projects/-app/<CLAUDE_SESSION_ID>/subagents/agent-<task_id>.{jsonl,meta.json}`) are kept. They are session-scoped logs useful for debugging and the stats panel; they are removed when the chat-service session ends.

### After cleanup

The lead replies to the user with one line per ticket:
- On success: "TASK-XXX done, merge commit `<sha>`."
- On failure: "TASK-XXX failed: `<reason>`. Branch retained at `<branch_name>`. (no auto-cleanup of the worktree on failure — user investigates)."

If there is a next wave (Phase 4), proceed; otherwise the workflow ends.

## Phase 4 — Multi-wave (cross-wave dependencies)

Some tickets depend on others. The PLANNER groups them into waves: wave 1 has all tickets with no dependencies, wave 2 has tickets whose dependencies are all merged after wave 1, etc.

When the wave 1 teardown (Phase 3) is complete, recompute the dependency graph and start a **new** Phase 1 for wave 2 — same `tickets` team_name (the previous one was deleted), new dispatches:

```
TeamCreate({team_name: "tickets", description: "Wave 2: TASK-006, TASK-007"})
// ... 4×N Agent dispatches for wave 2
// ... GO messages
// passive wait, etc.
```

Do not skip Phase 3 between waves — TeamDelete is mandatory before re-creating `tickets`. The teamdelete-cleanup hook makes the cycle reliable.

Stop when no pending tickets remain.

## Failure paths

| Scenario | Detected by | Reaction |
|---|---|---|
| Reviewer silent > 180s | developer (timeout in dev's prompt) | dev SendMessages team-lead, "TASK-XXX stuck on <reviewer>". Lead can SendMessage(reviewer-TASK-XXX, "ping?") or abort that ticket (see "Per-ticket abort" below). |
| Dev fix-cycle > 5 iterations | developer (counter in dev's prompt) | dev SendMessages team-lead, "TASK-XXX stuck: <N> cycles". Lead reformulates expectations to dev or aborts that ticket. |
| Merger merge conflict | merger | merger SendMessages team-lead, "TASK-XXX merge failed: <reason>". Lead either resumes dev for fix OR marks the ticket failed and moves on. |
| Hook `stop-hook-error` | system event arrives in lead's stream | Lead reads the event, decides if blocking. Validation hook crashes → treat as "validation skipped", warn user. |
| User pressed STOP | chat-service `cancelled` state | chat-service does brutal filesystem cleanup of `subagents/*` for the current session, doesn't wait for lead. |

### Per-ticket abort (within a live wave)

If one ticket goes wrong but the rest of the wave is healthy, the lead aborts only that ticket's members and lets the others run:

```
// Abort only TASK-001 — keep TASK-002, TASK-003 alive
SendMessage({to: "developer-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
SendMessage({to: "quality-reviewer-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
SendMessage({to: "test-validator-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
SendMessage({to: "merger-TASK-001", message: {type: "shutdown_request", reason: "ABORT"}})
// yield, verify shutdown_approved from these 4 only
// Do NOT TeamDelete yet — other tickets are still working.
```

Mark TASK-001 as failed in `${TICKETS_DIR}/TASK-001.json`. The other tickets continue. When the wave's remaining mergers all report back, do the standard Phase 3 teardown (which excludes the already-stopped TASK-001 members — they're in `stopped` state).

### Wave abort (full)

If the entire wave must be aborted (user STOP, irrecoverable error), follow the **same protocol as Phase 3 (3a→3d)**, but tag every shutdown_request with `reason: "ABORT"` so members know the workflow is being terminated, not completing normally:

```
1. SendMessage shutdown_request (reason: "ABORT") to ALL members in ONE message.
2. Yield the turn ("Aborting the wave and cleaning up…").
3. Verify shutdown_approved replies on the next turn.
4. TeamDelete({}). The PostToolUse cleanup hook handles residual disk artifacts.
5. Reply to user with abort reason.
```

The worktrees are left intact on abort, so the user can inspect or recover manually. Subagent transcripts persist as logs.

## Reference: addressing recipients

Single team `tickets`, all bare names (no `@team` suffix needed):

| Role | Name template |
|---|---|
| Lead (chat-orchestrator) | `team-lead` |
| Developer of ticket X | `developer-TASK-X` |
| Quality reviewer of ticket X | `quality-reviewer-TASK-X` (complex mode only) |
| Test validator of ticket X | `test-validator-TASK-X` (complex mode only) |
| Merger of ticket X | `merger-TASK-X` |

Members talk only to:
- their own ticket's counterparts (suffix matches their own `TASK_ID`)
- `team-lead` (status, escalation)

Cross-ticket SendMessage is forbidden by the per-agent protocol — each agent's prompt names exactly which counterpart suffixes it may address.
