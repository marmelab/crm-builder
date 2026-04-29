---
name: agent-team
description: Multi-agent team workflow for implementing tickets. Use when dispatching agents or following the full lifecycle (bootstrap → planning → wave-based parallel execution → review → reflection → merge). This skill is the single source of truth for how complex changes are implemented.
---

# Agent Team — Full Workflow

This skill is loaded by chat-orchestrator for any COMPLEX change. It describes every dispatch, every Phase, every mandatory step. Follow it exactly.

---

## Full lifecycle

### Phase 0 — Bootstrap (once per project)

Check `/app/docs/project-context.json` at project root:

- Does not exist or `validated: false` → dispatch PROJECT-MANAGER to produce it
- `validated: true` → proceed to Phase 1

### Phase 1 — Ticket planning (once per feature/need)

Dispatch PLANNER. Pass `TICKETS_DIR` (the session folder from `<session_dir>`) so the planner writes ticket files alongside the conversation's `log.jsonl` and `meta.json`:

```
Agent({
  subagent_type: "planner",
  description: "Plan tickets for: <user request>",
  prompt: "MODE=<mode>\nTICKETS_DIR=<session_dir>\n\n<user request>"
})
```

Planner produces:
- ordered list of TASK-XXX tickets written to `${TICKETS_DIR}/TASK-XXX.json`
- each ticket has `dependencies: []`, `parallel_safe: true/false`, `branch_name: feature/...`
- ticket list appended to `/app/docs/project-context.json` under `tickets`

### Phase 2 — Wave-based parallel execution

Read all new tickets. Group them into **waves**:

- **Wave 1**: tickets with `dependencies: []`
- **Wave N+1**: tickets whose dependencies are all merged after wave N
- A ticket with `parallel_safe: false` gets its own solo wave (never shares with siblings)

Run each wave concurrently. Wait for all teams of wave N to complete before starting wave N+1.

### Phase 2a — Ticket team lifecycle

For each ticket `TASK-XXX` in the current wave:

1. TeamCreate
2. Dispatch developer (ticket mode)
3. Dispatch reviewers (parallel)
4. If BLOCKED → re-dispatch developer for fix → re-run reviewers
5. All APPROVED → dispatch developer (Mode 2 reflection)
6. Dispatch merger
7. TeamDelete

See dispatch templates below.

### Phase 2b — Cross-wave gate

After all teams of wave N complete (all mergers done, all worktrees cleaned up), recompute the next wave from the updated dependency graph and start Phase 2a again. Stop when no pending tickets remain.

### Phase 3 — Session changelog (mandatory, once per session)

After the **final merger of the final wave** has reported success, dispatch CHANGELOG exactly once. This appends one entry to the cross-session changelog at `/chat-service/logs/changelog.json` (host: `sessions/changelog.json`) summarizing every ticket merged during the current session. Run it before sending the user the final "All done!" message.

```
Agent({
  subagent_type: "changelog",
  model: "haiku",
  description: "Write session changelog",
  prompt: "TICKETS_DIR=<session_dir>\nSESSION_ID=<session uuid — basename of session_dir>\nMODE=<mode>\n\nWrite the end-of-session changelog. All tickets in this session are now merged."
})
```

Do NOT dispatch CHANGELOG inside a `ticket-TASK-XXX` team — it is a session-scoped artifact, not a ticket-scoped one. Dispatch it at the orchestrator level (no `team_name`).

If CHANGELOG fails (file write error, missing tickets dir), do not retry more than once and do not block the user-facing completion message. The conversation log remains the source of truth; the changelog is a convenience artifact.

---

## CRITICAL RULE — Batch parallel work in ONE assistant message

**For a wave of N independent tickets, you MUST emit all 2N tool_use blocks (N TeamCreate + N Agent developer) in ONE SINGLE assistant response message.** Not two messages. Not "let me start with the first one, then the second". ONE message with the full batch.

### ✅ Correct — one assistant message with 4 tool_use blocks (2 tickets in wave)

```
<your ONE assistant message>
  [tool_use: TeamCreate({ team_name: "ticket-TASK-006", description: "..." })]
  [tool_use: TeamCreate({ team_name: "ticket-TASK-007", description: "..." })]
  [tool_use: Agent({ subagent_type: "developer", team_name: "ticket-TASK-006", ... })]
  [tool_use: Agent({ subagent_type: "developer", team_name: "ticket-TASK-007", ... })]
```

### ❌ Wrong — serialized across messages, wastes time

```
Message 1: [tool_use: TeamCreate(TASK-006)] [tool_use: TeamCreate(TASK-007)]
Message 2: [tool_use: Agent(developer TASK-006)]
(wait for TASK-006 to finish completely)
Message N: [tool_use: Agent(developer TASK-007)]
```

If you announced to the user *"I'll run them in parallel"* then emit the developer dispatches in separate messages, you have contradicted yourself. Do NOT do this.

**Rule of thumb**: if your next user-facing message starts with *"Je lance la première étape"* / *"I start with the first one"*, you're about to serialize a parallel wave by mistake. Change to *"Je lance les étapes en parallèle"* and emit all dispatches in that one response.

This rule also applies to:
- The two reviewers of a ticket (quality-reviewer + test-validator) → same message
- Any read-only lookup sequence where one result doesn't feed the next

---

## Dispatch templates

### Developer (ticket mode, implementation)

```
Agent({
  subagent_type: "developer",
  team_name: "ticket-TASK-XXX",
  model: "opus",
  description: "Implement TASK-XXX",
  prompt: "WORKTREE_PATH=/worktrees/TASK-XXX\nBRANCH_NAME=<ticket.branch_name>\nMODE=<mode>\nTICKETS_DIR=<session_dir>\n\nTASK: ${TICKETS_DIR}/TASK-XXX.json"
})
```

### Reviewers (parallel, same assistant message)

```
Agent({
  subagent_type: "quality-reviewer",
  team_name: "ticket-TASK-XXX",
  model: "sonnet",
  description: "Review TASK-XXX",
  prompt: "TICKETS_DIR=<session_dir>\n\nReview ${TICKETS_DIR}/TASK-XXX.json implementation in worktree /worktrees/TASK-XXX"
})
Agent({
  subagent_type: "test-validator",
  team_name: "ticket-TASK-XXX",
  model: "haiku",
  description: "Validate TASK-XXX",
  prompt: "TICKETS_DIR=<session_dir>\n\nValidate ${TICKETS_DIR}/TASK-XXX.json implementation in worktree /worktrees/TASK-XXX"
})
```

`<session_dir>` above is a placeholder — substitute the literal absolute path from your system prompt's `<session_dir>` tag.

### Developer (fix mode, after BLOCKED)

Re-dispatch the same developer agent in the same team, with a prompt that includes the reviewer's blocking issues. Use `model: "sonnet"` for small fixes (doc missing, typecheck fix, single-line change) — cheaper and enough.

### Developer (Mode 2 reflection — NOT optional before merger)

```
Agent({
  subagent_type: "developer",
  team_name: "ticket-TASK-XXX",
  model: "sonnet",
  description: "Write reflection for TASK-XXX",
  prompt: "MODE 2 — REFLECTION.\n\nWORKTREE_PATH=/worktrees/TASK-XXX\nBRANCH_NAME=<ticket.branch_name>\nTASK_ID=TASK-XXX\nTICKETS_DIR=<session_dir>\n\nThe ticket is implemented and reviewed. Your job now: invoke Skill({skill: 'reflection-writing'}) first, then read past reflections in /app/docs/reflections/, then write /app/docs/reflections/TASK-XXX-reflection.md. Do NOT touch code. Commit the reflection file in the worktree with message 'docs(TASK-XXX): reflection'."
})
```

Reflection runs on sonnet — it's prose, not heavy reasoning. Reflection captures the learnings for future dev sessions and MUST happen before merger.

### Merger (NOT optional)

```
Agent({
  subagent_type: "merger",
  team_name: "ticket-TASK-XXX",
  model: "haiku",
  description: "Merge TASK-XXX",
  prompt: "TASK_ID=TASK-XXX\nBRANCH_NAME=<ticket.branch_name>\nWORKTREE_PATH=/worktrees/TASK-XXX\nTICKETS_DIR=<session_dir>"
})
```

Merger responsibilities:
1. Merge the feature branch into the base branch (`master` or `main`)
2. Remove the worktree
3. Delete the feature branch
4. Update the ticket JSON status to `"merged"`

**Mandatory check before TeamDelete**: confirm MERGER was dispatched AND reported success for this ticket. If not, dispatch it now. No "session limit", no "I'll let the user do it" — the merger is fast (usually < 30s on haiku) and it's the whole point of the flow. If you end the ticket without dispatching merger, the branch stays orphaned and the user's change is **invisible in the running app**.

### TeamDelete

```
TeamDelete({ team_name: "ticket-TASK-XXX" })
```

Call this only after merger reported success.

---

## Ticket format in `${TICKETS_DIR}/TASK-XXX.json`

```json
{
  "ticket_id": "TASK-001",
  "title": "Short imperative title",
  "description": "What needs to be done and why",
  "type": "feature|fix|migration|config",
  "risk_level": "low|medium|high",
  "acceptance_criteria": [
    "Specific, testable, verifiable statement"
  ],
  "non_functional_requirements": {
    "performance": "...",
    "security": "...",
    "scalability": "..."
  },
  "files_to_modify": ["src/..."],
  "dependencies": ["TASK-000"],
  "parallel_safe": true,
  "branch_name": "feature/short-name-TASK-001",
  "status": "pending|in_progress|merged"
}
```

All agents read tickets from `${TICKETS_DIR}/TASK-XXX.json` (the per-session folder, e.g. `/chat-service/logs/<uuid>/TASK-XXX.json`) — this is the source of truth. The orchestrator passes the absolute path as `TICKETS_DIR` in every dispatch prompt.

---

## Model routing

| Agent | Model | Rationale |
|---|---|---|
| PROJECT-MANAGER | sonnet | bootstrap, light reasoning |
| PLANNER | sonnet | decomposition, file discovery |
| ARCHITECT | sonnet | rarely used |
| DEVELOPER (ticket implementation) | **opus** | complex coding |
| DEVELOPER (fix after BLOCKED) | **sonnet** | small change |
| DEVELOPER (Mode 2 reflection) | **sonnet** | prose |
| QUALITY-REVIEWER | sonnet | semantic review |
| TEST-VALIDATOR | haiku | structural checks |
| MERGER | haiku | mechanical git ops |
| CHANGELOG | haiku | end-of-session prose summary |

---

## Global rules

- **Any BLOCKED = no merge**: one blocking verdict from any reviewer stops the merge. Re-dispatch developer to fix, then re-run reviewers.
- **Reflection before merge**: after all reviews APPROVED, developer Mode 2 writes reflection, THEN merger merges.
- **Merger is mandatory**: no ticket completes without merger success. No shortcuts.
- **Changelog is mandatory**: no session completes without CHANGELOG dispatched once after the final merger. See Phase 3.
- **Ticket source of truth**: `${TICKETS_DIR}/TASK-XXX.json` (per-session folder). All agents read here, never from memory alone.
- **Worktree isolation**: each ticket works in `/worktrees/TASK-XXX/` — see `.claude/rules/worktree-scope.md`.
- **e2e tests**: mandatory for any UI/filter/interaction task unless acceptance_criteria explicitly states otherwise.
- **Parallel tickets**: tickets in the same wave with no deps between them MUST be dispatched in ONE assistant message (see CRITICAL RULE above).
