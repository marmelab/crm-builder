---
name: agent-team
description: Multi-agent team workflow for implementing tickets with peer-to-peer communication. Use when dispatching agents or following the full lifecycle (bootstrap → planning → wave-based parallel execution → ticket-team → cleanup). This skill is the single source of truth for how the team communicates.
---

# Agent Team — Peer-to-peer workflow

This skill is invoked by `chat-orchestrator` (team-lead role) and by every ticket-team member at startup. It describes the full lifecycle and every cross-agent message.

## TL;DR

For every ticket, the lead spawns 4 named team members upfront, sends a single GO message to the developer, then stays passive until the merger pings it back. Reviewers and developer fix-cycle directly. Developer counts approvals; when all approved, runs Mode 2 reflection, then SendMessages merger. Merger merges, pings lead. Lead does deterministic filesystem cleanup of subagent transcripts.

## When to use

- Lead (chat-orchestrator): after classifying the user request as a code change.
- Each team member: at the start of their first activation, to know the protocol.

## Modes

- **Simple mode:** developer + merger only (2 agents). No reviewers, no Mode 2 reflection. Used for one-shot UI tweaks ("rename label X to Y", "hide button Z"), single-file edits, no test impact.
- **Complex mode:** developer + quality-reviewer + test-validator + merger (4 agents). Mode 2 reflection between all-APPROVED and SendMessage merger. Used for multi-file features, anything touching data flow, anything affecting tests, anything ambiguous.

The lead classifies in its first turn based on the user request. The default for ambiguous cases is **complex** (false positives are cheap, missed reviews are not).

## SendMessage addressing — bare names by default

The runtime's `SendMessage` tool accepts the recipient in `to:` either as:
- **Bare name** (`developer`, `merger`, `quality-reviewer`, `test-validator`, `team-lead`) — works when the sender's session has exactly one team in scope. The runtime will reject `name@team` here with "to must be a bare teammate name — there is only one team per session".
- **`name@team_name`** (e.g. `developer@ticket-TASK-002`) — required when the sender (typically the lead) has multiple active teams and bare name is ambiguous.

**Default everywhere in this skill: bare name.** Add the `@team_name` suffix only when the lead is orchestrating ≥2 ticket-teams concurrently (multi-ticket flows). Teammates always use bare names — they only see their own team.

## Phase 1 — Team setup (lead only)

The lead does this in ONE assistant message (one tool_use block per agent, in parallel):

```
TeamCreate({team_name: "ticket-TASK-XXX", description: "<short ticket description>"})

Agent({
  subagent_type: "developer",
  name: "developer",
  team_name: "ticket-TASK-XXX",
  model: "opus",
  description: "Implement TASK-XXX",
  prompt: "<see Phase 2 — developer protocol>"
})

Agent({  // complex mode only
  subagent_type: "quality-reviewer",
  name: "quality-reviewer",
  team_name: "ticket-TASK-XXX",
  model: "sonnet",
  description: "Review TASK-XXX",
  prompt: "<see Phase 2 — quality-reviewer protocol>"
})

Agent({  // complex mode only
  subagent_type: "test-validator",
  name: "test-validator",
  team_name: "ticket-TASK-XXX",
  model: "sonnet",
  description: "Validate TASK-XXX",
  prompt: "<see Phase 2 — test-validator protocol>"
})

Agent({
  subagent_type: "merger",
  name: "merger",
  team_name: "ticket-TASK-XXX",
  model: "haiku",
  description: "Merge TASK-XXX",
  prompt: "<see Phase 2 — merger protocol>"
})
```

After all spawns return, the lead sends ONE go message to the developer (bare name in single-ticket flows; replace `developer` with `developer@ticket-TASK-XXX` if managing ≥2 teams concurrently):

```
SendMessage({
  to: "developer",
  message: "GO — Implement TASK-XXX (worktree=/worktrees/TASK-XXX, branch=<ticket.branch_name>, mode=<demo|full>). Ticket spec: <ticket file path or inline>. After all reviewers APPROVED, write reflection (Mode 2), then SendMessage merger. Reviewers: [quality-reviewer, test-validator]. Merger: merger."
})
```

In simple mode, omit the reviewer entries; the message says "no reviewers, no reflection, SendMessage merger directly when commit is ready".

After SendMessage(developer, "GO"), the lead enters **passive wait** for the final SendMessage from `merger` (or `merger@ticket-TASK-XXX` in multi-ticket) reporting "merged X" or "merge failed: <reason>".

## Phase 2 — Per-agent protocols

Each agent's prompt (sent at spawn) includes their role-specific protocol below.

### developer

```
ROLE: developer
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json (complex) or <inline> (simple)
TEAMMATES: [reviewers list], merger
TEAM_LEAD: team-lead

WORKFLOW (bare names; teammates only see their own team):
1. Read the ticket spec.
2. Implement in the worktree (Edit/Write/Bash). Commit when ready.
3. (complex mode) SendMessage(to: "quality-reviewer", "ready, please review"). SendMessage(to: "test-validator", "ready, please validate"). Initialize approvals_needed=2, approvals_received=0.
4. (simple mode) Skip step 3. Go to step 7 directly.
5. Wait for replies. For each:
   - "APPROVED" → approvals_received++
   - "BLOCKED: ..." → reset approvals_received=0, apply the fixes, commit, then re-notify ALL reviewers (R1: re-notify those that previously APPROVED too, since the diff changed). Loop step 5.
6. When approvals_received == approvals_needed:
   - Bascule en Mode 2 (reflection): read /app/docs/reflections/, write /worktrees/TASK-XXX/docs/reflections/TASK-XXX-reflection.md, commit.
7. SendMessage(to: "merger", "ready: all approved + reflection committed" (or "ready: simple mode" in simple)).
8. After SendMessage(merger), stop. Lead handles cleanup.

TIMEOUTS:
- If a reviewer doesn't reply within 180s, SendMessage(to: "team-lead", "stuck on <reviewer>: no reply for 180s").
- If the same fix-cycle has run >5 times without convergence, SendMessage(to: "team-lead", "stuck: <N> cycles, can't satisfy <reviewer>").
```

### quality-reviewer

```
ROLE: quality-reviewer
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
TEAMMATES: developer, test-validator, merger
TEAM_LEAD: team-lead

WORKFLOW (per incoming SendMessage from developer):
1. Read the ticket and the worktree diff (`git -C /worktrees/TASK-XXX diff <base>..HEAD`).
2. Apply the rules from .claude/rules/coding-style.md and .claude/rules/agent-output-format.md. Skim .claude/rules/security-triggers.md for anything that warrants security flagging.
3. Verdict:
   - All clear → SendMessage(to: "developer", "APPROVED")
   - Issues to fix → SendMessage(to: "developer", "BLOCKED:\n- file: ...\n  line: ...\n  description: ...\n  fix: ...\n- ...\nSummary: N blocking issues.")
4. After SendMessage, stop. Wait for next incoming message (re-review after dev's fix).

DO NOT:
- Run validations (typecheck, e2e, etc.) — those are handled by the PreToolUse hook on the dev side.
- SendMessage anyone other than developer. You don't talk to other reviewers, you don't talk to merger.
- Re-spawn agents or call TeamCreate/TeamDelete.
```

### test-validator

```
ROLE: test-validator
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
TEAMMATES: developer, quality-reviewer, merger
TEAM_LEAD: team-lead

WORKFLOW (per incoming SendMessage from developer):
1. Read the ticket and the worktree.
2. Verify TEST PRESENCE: every new behavior in the diff has at least one corresponding test (unit or e2e per .claude/rules/testing.md).
3. Verify TEST PERTINENCE: judge whether the assertions actually cover the failure modes that matter. A test that always passes (e.g. asserting truthy on a literal) is not pertinent.
4. Read .claude/skills/e2e-conventions to know when an e2e is required.
5. Verdict (same format as quality-reviewer):
   - SendMessage(to: "developer", "APPROVED") if presence + pertinence both OK
   - SendMessage(to: "developer", "BLOCKED:\n- ...") otherwise

DO NOT:
- Run the tests (the PreToolUse hook does that on the dev side). Your job is reading + judging coverage and pertinence, not running.
- SendMessage other reviewers or merger.
```

### merger

```
ROLE: merger
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
BRANCH: <ticket.branch_name>
TEAM_LEAD: team-lead

WORKFLOW (per incoming SendMessage):
- If sender is developer and message is "ready" → proceed.
- Anything else → SendMessage(to: "team-lead", "merger received unexpected message: <quote>") and stop.

MERGE STEPS:
1. cd /app && git fetch
2. git checkout <base branch> && git pull --ff-only (or document if no remote)
3. git reset --hard HEAD ; /entrypoint-helpers/apply-app-variant.sh (re-applies App.tsx variant)
4. git merge --no-ff <ticket.branch_name> -m "chore(ticket-TASK-XXX): merge"
5. If merge succeeds: git worktree remove /worktrees/TASK-XXX ; git branch -d <ticket.branch_name>
6. SendMessage(to: "team-lead", "merged TASK-XXX, commit=<short sha>")
7. If merge fails (conflict, hook block, etc.): SendMessage(to: "team-lead", "merge failed: <reason>") and stop.

CRITICAL — what merger NEVER does:
- `git add` / `git commit` of any file (only git merge + git reset --hard HEAD on /app are allowed; see CLAUDE.md "Merger never fabricates commits")
- Spawn agents, TeamCreate, TeamDelete
- Edit any file in /app or worktree (validation already done upstream by hooks)
```

## Phase 3 — Graceful team shutdown (lead only)

When the lead receives `SendMessage(to: "team-lead", "merged X")` or `"merge failed: ..."` from the merger, the workflow is done but the agents' OS processes may still be alive (the runtime keeps them around for graceful termination). A clean shutdown drains all messages so no unread "embryos" survive on disk.

### Step 3a — SendMessage shutdown_request to each member

In ONE assistant message, send a shutdown_request to every active member of the team:

```
SendMessage({to: "developer", message: {type: "shutdown_request"}})
SendMessage({to: "merger", message: {type: "shutdown_request"}})
// (complex mode also: quality-reviewer, test-validator)
```

### Step 3b — Yield the turn so replies are delivered

Emit a brief assistant text (e.g. *"Wrapping up the team…"*) and stop. The runtime delivers each member's `shutdown_approved` reply on the **next** user turn as a `<teammate-message>` block. Receiving them in the lead's turn-stream marks them **read**, so they will not become embryos. **Do not call any other tool in this turn — yielding is what lets the runtime deliver the replies.**

### Step 3c — Verify each member acknowledged

On the next turn, scan the incoming `<teammate-message>` blocks for `shutdown_approved` from every member you requested:

- ✅ All approved → proceed to Step 3d.
- ❌ One or more missing after ~10s of yielded waiting → log a brief message to the user (e.g. *"member &lt;name&gt; didn't acknowledge shutdown — proceeding anyway"*) and proceed; investigation can happen post-hoc by reading the member's transcript at `/home/developer/.claude/projects/-app/$CLAUDE_SESSION_ID/subagents/agent-<task_id>.jsonl`.

### Step 3d — TeamDelete

```
TeamDelete({})
```

`{}` (no input) is accepted and means "the only team this session has open". This releases the runtime's in-memory team registration. If the lead is orchestrating ≥2 ticket-teams concurrently (multi-ticket flow), pass the explicit form instead: `TeamDelete({"team_name": "ticket-TASK-XXX"})`.

After 3a→3c, the inbox files are all read (or empty), so TeamDelete will not preserve any "embryo" message file.

> **Hook enforcement.** A `PreToolUse` hook (`teamdelete-gate.sh`) blocks TeamDelete if any non-lead member has not been fully shut down (no `shutdown_approved` from them in the lead's inbox, or one is present but unread). If you see *"TeamDelete blocked: N teammate(s) ... have not been gracefully shut down"*, follow the steps the hook lists and **do not retry TeamDelete in the same turn** — that will fail identically. Yield first, then retry on the next turn.

### Step 3e — automated cleanup (no action required)

A `PostToolUse` hook (`teamdelete-cleanup.sh`) runs after every successful `TeamDelete` and removes the residual team directory `~/.claude/teams/<team_name>/` (the runtime leaves behind `inboxes/` and other artifacts). The lead has nothing to do for this step — the hook is silent and runs in the background.

### What is intentionally NOT cleaned

Subagent transcripts (`/home/developer/.claude/projects/-app/<CLAUDE_SESSION_ID>/subagents/agent-<task_id>.{jsonl,meta.json}`) are kept. They are session-scoped logs useful for debugging and the stats panel; they are removed when the chat-service session ends.

### After cleanup

The lead replies to the user:
- On success: "TASK-XXX done, merge commit `<sha>`."
- On failure: "TASK-XXX failed: `<reason>`. Branch retained at `<branch_name>`. (no auto-cleanup of the worktree on failure — user investigates)."

### Multi-ticket flows

Call Steps 3a + 3b once per ticket-team after each merger reports back. Do not batch — keep the per-team scope explicit.

## Failure paths

| Scenario | Detected by | Reaction |
|---|---|---|
| Reviewer silent > 180s | developer (timeout in dev's prompt) | dev SendMessages team-lead, "stuck on <reviewer>". Lead can SendMessage(reviewer, "ping?") or abort with cleanup. |
| Dev fix-cycle > 5 iterations | developer (counter in dev's prompt) | dev SendMessages team-lead, "stuck: <N> cycles". Lead reformulates expectations to dev or aborts. |
| Merger merge conflict | merger | merger SendMessages team-lead, "merge failed: <reason>". Lead either resumes dev for fix OR aborts with cleanup. |
| Hook `stop-hook-error` | system event arrives in lead's stream | Lead reads the event, decides if blocking. Validation hook crashes → treat as "validation skipped", warn user. |
| User pressed STOP | chat-service `cancelled` state | chat-service does brutal filesystem cleanup of `subagents/*` for the current session, doesn't wait for lead. |

### Abort path (lead-initiated)

If the lead decides to abort (timeout, user cancel, irrecoverable error), follow the **same graceful shutdown** protocol as Phase 3 (3a→3d), but send an `ABORT` payload alongside the shutdown_request so members know the workflow is being terminated, not completing normally:

```
1. SendMessage({to: "developer", message: {type: "shutdown_request", reason: "ABORT"}})
   SendMessage({to: "merger",    message: {type: "shutdown_request", reason: "ABORT"}})
   (complex mode: also quality-reviewer, test-validator)
2. Yield the turn ("Aborting and cleaning up…").
3. Verify shutdown_approved replies on the next turn.
4. TeamDelete({}). The PostToolUse cleanup hook handles residual disk artifacts.
5. Reply to user with abort reason.
```

The worktree is left intact on abort, so the user can inspect or recover manually. Subagent transcripts persist as logs.

## Reference: addressing recipients

Within a single team, every agent uses **bare names**:

- `team-lead` — the chat-orchestrator (auto-registered as lead by TeamCreate)
- `developer`
- `quality-reviewer` (complex mode only)
- `test-validator` (complex mode only)
- `merger`

For multi-ticket flows where the lead orchestrates ≥2 ticket-teams concurrently, the lead disambiguates with the `@team_name` suffix (e.g. `developer@ticket-TASK-002`). Teammates always use bare names; they only ever see their own team.
