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

After all spawns return, the lead sends ONE go message to the developer:

```
SendMessage({
  to: "developer@ticket-TASK-XXX",
  message: "GO — Implement TASK-XXX (worktree=/worktrees/TASK-XXX, branch=<ticket.branch_name>, mode=<demo|full>). Ticket spec: <ticket file path or inline>. After all reviewers APPROVED, write reflection (Mode 2), then SendMessage merger@ticket-TASK-XXX. Reviewers: [quality-reviewer@ticket-TASK-XXX, test-validator@ticket-TASK-XXX]. Merger: merger@ticket-TASK-XXX."
})
```

In simple mode, omit the reviewer entries; the message says "no reviewers, no reflection, SendMessage merger directly when commit is ready".

After SendMessage(developer, "GO"), the lead enters **passive wait** for the final SendMessage from `merger@ticket-TASK-XXX` reporting "merged X" or "merge failed: <reason>".

## Phase 2 — Per-agent protocols

Each agent's prompt (sent at spawn) includes their role-specific protocol below.

### developer@ticket-TASK-XXX

```
ROLE: developer
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json (complex) or <inline> (simple)
TEAMMATES: [reviewers list], merger@ticket-TASK-XXX
TEAM_LEAD: team-lead@ticket-TASK-XXX

WORKFLOW:
1. Read the ticket spec.
2. Implement in the worktree (Edit/Write/Bash). Commit when ready.
3. (complex mode) SendMessage(quality-reviewer@..., "ready, please review"). SendMessage(test-validator@..., "ready, please validate"). Initialize approvals_needed=2, approvals_received=0.
4. (simple mode) Skip step 3. Go to step 7 directly.
5. Wait for replies. For each:
   - "APPROVED" → approvals_received++
   - "BLOCKED: ..." → reset approvals_received=0, apply the fixes, commit, then re-notify ALL reviewers (R1: re-notify those that previously APPROVED too, since the diff changed). Loop step 5.
6. When approvals_received == approvals_needed:
   - Bascule en Mode 2 (reflection): read /app/docs/reflections/, write /worktrees/TASK-XXX/docs/reflections/TASK-XXX-reflection.md, commit.
7. SendMessage(merger@ticket-TASK-XXX, "ready: all approved + reflection committed (or "ready: simple mode" in simple)").
8. After SendMessage(merger), stop. Lead handles cleanup.

TIMEOUTS:
- If a reviewer doesn't reply within 180s, SendMessage(team-lead@..., "stuck on <reviewer>: no reply for 180s").
- If the same fix-cycle has run >5 times without convergence, SendMessage(team-lead@..., "stuck: <N> cycles, can't satisfy <reviewer>").
```

### quality-reviewer@ticket-TASK-XXX

```
ROLE: quality-reviewer
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
TEAMMATES: developer@ticket-TASK-XXX, test-validator@ticket-TASK-XXX, merger@ticket-TASK-XXX
TEAM_LEAD: team-lead@ticket-TASK-XXX

WORKFLOW (per incoming SendMessage from developer):
1. Read the ticket and the worktree diff (`git -C /worktrees/TASK-XXX diff <base>..HEAD`).
2. Apply the rules from .claude/rules/coding-style.md and .claude/rules/agent-output-format.md. Skim .claude/rules/security-triggers.md for anything that warrants security flagging.
3. Verdict:
   - All clear → SendMessage(developer@..., "APPROVED")
   - Issues to fix → SendMessage(developer@..., "BLOCKED:\n- file: ...\n  line: ...\n  description: ...\n  fix: ...\n- ...\nSummary: N blocking issues.")
4. After SendMessage, stop. Wait for next incoming message (re-review after dev's fix).

DO NOT:
- Run validations (typecheck, e2e, etc.) — those are handled by the PreToolUse hook on the dev side.
- SendMessage anyone other than developer@... You don't talk to other reviewers, you don't talk to merger.
- Re-spawn agents or call TeamCreate/TeamDelete.
```

### test-validator@ticket-TASK-XXX

```
ROLE: test-validator
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json
TEAMMATES: developer@ticket-TASK-XXX, quality-reviewer@ticket-TASK-XXX, merger@ticket-TASK-XXX
TEAM_LEAD: team-lead@ticket-TASK-XXX

WORKFLOW (per incoming SendMessage from developer):
1. Read the ticket and the worktree.
2. Verify TEST PRESENCE: every new behavior in the diff has at least one corresponding test (unit or e2e per .claude/rules/testing.md).
3. Verify TEST PERTINENCE: judge whether the assertions actually cover the failure modes that matter. A test that always passes (e.g. asserting truthy on a literal) is not pertinent.
4. Read .claude/skills/e2e-conventions to know when an e2e is required.
5. Verdict (same format as quality-reviewer):
   - SendMessage(developer@..., "APPROVED") if presence + pertinence both OK
   - SendMessage(developer@..., "BLOCKED:\n- ...") otherwise

DO NOT:
- Run the tests (the PreToolUse hook does that on the dev side). Your job is reading + judging coverage and pertinence, not running.
- SendMessage other reviewers or merger.
```

### merger@ticket-TASK-XXX

```
ROLE: merger
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
BRANCH: <ticket.branch_name>
TEAM_LEAD: team-lead@ticket-TASK-XXX

WORKFLOW (per incoming SendMessage):
- If sender is developer@... and message is "ready" → proceed.
- Anything else → SendMessage(team-lead@..., "merger received unexpected message: <quote>") and stop.

MERGE STEPS:
1. cd /app && git fetch
2. git checkout <base branch> && git pull --ff-only (or document if no remote)
3. git reset --hard HEAD ; /entrypoint-helpers/apply-app-variant.sh (re-applies App.tsx variant)
4. git merge --no-ff <ticket.branch_name> -m "chore(ticket-TASK-XXX): merge"
5. If merge succeeds: git worktree remove /worktrees/TASK-XXX ; git branch -d <ticket.branch_name>
6. SendMessage(team-lead@..., "merged TASK-XXX, commit=<short sha>")
7. If merge fails (conflict, hook block, etc.): SendMessage(team-lead@..., "merge failed: <reason>") and stop.

CRITICAL — what merger NEVER does:
- `git add` / `git commit` of any file (only git merge + git reset --hard HEAD on /app are allowed; see CLAUDE.md "Merger never fabricates commits")
- Spawn agents, TeamCreate, TeamDelete
- Edit any file in /app or worktree (validation already done upstream by hooks)
```

## Phase 3 — Cleanup (lead only)

When the lead receives `SendMessage(team-lead@..., "merged X")` or `"merge failed: ..."` from the merger, it does:

```
# Filesystem cleanup of subagent transcripts (TeamDelete does NOT remove these)
Bash({
  command: "TEAM=ticket-TASK-XXX; SID=\"$CLAUDE_SESSION_ID\"; \
    rm -f /home/developer/.claude/projects/-app/$SID/subagents/agent-developer@$TEAM.{jsonl,meta.json}; \
    rm -f /home/developer/.claude/projects/-app/$SID/subagents/agent-quality-reviewer@$TEAM.{jsonl,meta.json}; \
    rm -f /home/developer/.claude/projects/-app/$SID/subagents/agent-test-validator@$TEAM.{jsonl,meta.json}; \
    rm -f /home/developer/.claude/projects/-app/$SID/subagents/agent-merger@$TEAM.{jsonl,meta.json}; \
    rm -f /tmp/claude-1001/-app/$SID/tasks/*@$TEAM.output; \
    echo cleanup_done"
})

# Then TeamDelete cleans up team config and tasks dirs
TeamDelete({team_name: "ticket-TASK-XXX"})
```

If `$CLAUDE_SESSION_ID` is not set in the env (verified in Phase 0 Q3), the chat-service must inject it (Phase 4 Task 4.2). The skill assumes it IS set.

In simple mode, only `agent-developer@*` and `agent-merger@*` exist — the rm for reviewers is harmless (no-op if file missing).

After cleanup, the lead replies to the user:
- On success: "TASK-XXX done, merge commit `<sha>`."
- On failure: "TASK-XXX failed: `<reason>`. Branch retained at `<branch_name>`. (no auto-cleanup of the worktree on failure — user investigates)."

## Failure paths

| Scenario | Detected by | Reaction |
|---|---|---|
| Reviewer silent > 180s | developer (timeout in dev's prompt) | dev SendMessages team-lead, "stuck on <reviewer>". Lead can SendMessage(reviewer, "ping?") or abort with cleanup. |
| Dev fix-cycle > 5 iterations | developer (counter in dev's prompt) | dev SendMessages team-lead, "stuck: <N> cycles". Lead reformulates expectations to dev or aborts. |
| Merger merge conflict | merger | merger SendMessages team-lead, "merge failed: <reason>". Lead either resumes dev for fix OR aborts with cleanup. |
| Hook `stop-hook-error` | system event arrives in lead's stream | Lead reads the event, decides if blocking. Validation hook crashes → treat as "validation skipped", warn user. |
| User pressed STOP | chat-service `cancelled` state | chat-service does brutal filesystem cleanup of `subagents/*` for the current session, doesn't wait for lead. |

### Abort path (lead-initiated)

If the lead decides to abort (timeout, user cancel, irrecoverable error):

```
1. SendMessage(developer@..., "ABORT") — best-effort, dev may or may not act on it
2. Bash filesystem cleanup of subagent transcripts (same as Phase 3)
3. TeamDelete (succeeds even with dormant agents in our case — they're task subagents, not active members)
4. Reply to user with abort reason
```

The worktree is left intact on abort, so the user can inspect or recover manually.

## Reference: name@team IDs

For team_name `ticket-TASK-XXX`, the predictable agent IDs are:

- `team-lead@ticket-TASK-XXX` — the chat-orchestrator (auto-registered as lead by TeamCreate)
- `developer@ticket-TASK-XXX`
- `quality-reviewer@ticket-TASK-XXX` (complex mode only)
- `test-validator@ticket-TASK-XXX` (complex mode only)
- `merger@ticket-TASK-XXX`

These IDs are deterministic and known by every team member at spawn time (passed in their initial prompt).
