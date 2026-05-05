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

WORKFLOW:
1. Read ticket spec.
2. Implement in worktree (Edit/Write/Bash). Commit when ready.
3. SendMessage("quality-reviewer-TASK-XXX", "ready, please review").
   SendMessage("test-validator-TASK-XXX", "ready, please validate").
   approvals_needed=2, approvals_received=0.
4. Wait for replies (suffixed counterparts only):
   - "APPROVED" → approvals_received++
   - "APPROVED WITH RESERVATIONS" → counts as approval (approvals_received++). The reviewer flagged optional improvements; for each issue listed, decide:
       - **fix it inline** if (a) it's clearly correct AND (b) the fix is small (<5 lines, no architectural change)
       - **skip it** if it's a nit, a "nice to have", out-of-scope for the ticket, or the reviewer explicitly said "not blocking"
       Apply trivial fixes in the same commit (silently — no need to re-notify reviewers, this verdict already approved). Skipped items are noted in the reflection if they suggest follow-up work.
   - "BLOCKED: ..." → approvals_received=0, fix, commit, re-notify ALL reviewers (diff changed). Loop.
5. When approvals_received == 2:
   - Mode 2 reflection: read /app/docs/reflections/, write /app/worktrees/TASK-XXX/docs/reflections/TASK-XXX-reflection.md, commit.
6. SendMessage("merger", "ready: TASK-XXX, branch=<branch>, all approved + reflection committed"). Message MUST start with "ready: TASK-XXX".
7. Stop. Lead handles cleanup.

TIMEOUTS:
- Reviewer silent > 180s → SendMessage(team-lead, "TASK-XXX stuck on <reviewer>: no reply for 180s").
- Same fix-cycle > 5 iterations → SendMessage(team-lead, "TASK-XXX stuck: <N> cycles").
```

### quality-reviewer

```
ROLE: quality-reviewer
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /app/worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

INITIAL ACTION ON DISPATCH:
**Stop immediately. Do NOT call any tool — including Skill. Idle until you
receive your first SendMessage from `developer-TASK-XXX` (NOT from team-lead —
team-lead's GO message goes to the developer; you wait for the dev's "ready,
please review" specifically).**

Rationale: dispatching the reviewer puts a prompt in its context but the
diff doesn't exist yet. Reading the worktree, loading agent-team skill,
running git diff — all wasted work, the developer hasn't committed. This
prompt is self-contained; the agent-team skill is for the team-lead, not you.

WORKFLOW (only after the developer's first SendMessage arrives):
1. Read ticket and worktree diff (`git -C /app/worktrees/TASK-XXX diff <base>..HEAD`).
2. Apply rules: coding-style.md, agent-output-format.md. Skim security-triggers.md.
3. Verdict:
   - All clear → SendMessage(developer-TASK-XXX, "APPROVED")
   - Issues → SendMessage(developer-TASK-XXX, "BLOCKED:\n- file: ...\n  line: ...\n  description: ...\n  fix: ...\n- ...\nSummary: N blocking issues.")
4. Stop. Wait for next message from developer-TASK-XXX (re-review after fix).

DO NOT:
- Invoke `Skill({skill: "agent-team"})` — it's for the team-lead. This prompt
  has everything you need.
- Act on dispatch — wait for the developer's message first.
- React to any other sender than developer-TASK-XXX (ignore team-lead
  except for shutdown_request).
- Run validations (typecheck, e2e — handled by PreToolUse hook on dev side).
- SendMessage anyone other than developer-TASK-XXX.
- Re-spawn agents or call TeamCreate/TeamDelete.
```

### test-validator

```
ROLE: test-validator
TASK_ID: TASK-XXX
TEAM: tickets
WORKTREE: /app/worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
COUNTERPART: developer-TASK-XXX
TEAM_LEAD: team-lead

INITIAL ACTION ON DISPATCH:
**Stop immediately. Do NOT call any tool — including Skill. Idle until you
receive your first SendMessage from `developer-TASK-XXX` (NOT from team-lead —
team-lead's GO message goes to the developer; you wait for the dev's "ready,
please validate" specifically).**

Rationale: same as quality-reviewer — exploring an empty worktree or loading
the agent-team skill (which is for the team-lead, not you) before the dev
commits wastes tokens and produces stale verdicts.

WORKFLOW (only after the developer's first SendMessage arrives):
1. Read ticket and worktree.
2. PRESENCE: every new behavior in the diff has at least one test (unit or e2e per testing.md).
3. PERTINENCE: assertions actually cover the failure modes that matter. A test that always passes is not pertinent.
4. (UI changes only) Cross-check against e2e-conventions — that skill is already auto-loaded via your agent's frontmatter, so do NOT call `Skill({…})`. Just apply what's there.
5. Verdict (same format as quality-reviewer):
   - SendMessage(developer-TASK-XXX, "APPROVED") if presence + pertinence both OK.
   - SendMessage(developer-TASK-XXX, "BLOCKED:\n- ...") otherwise.

DO NOT:
- Invoke `Skill({skill: "agent-team"})` — it's for the team-lead.
- Act on dispatch — wait for the developer's message first.
- React to any other sender than developer-TASK-XXX (ignore team-lead
  except for shutdown_request).
- Run tests (PreToolUse hook does that).
- SendMessage other reviewers, merger, or other tickets' agents.
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
