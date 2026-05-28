# Replace Agent Team with standard subagents

**Date**: 2026-05-28
**Branch**: `test/noAgentTeam`
**Goal**: rewire the agent workflow in `test-noAgentTeam` to use standard one-shot subagents instead of the Agent Team primitive (`TeamCreate` / `team_name` / `SendMessage`). The two codebases (`crm-builder` baseline vs `test-noAgentTeam`) will then be compared on cost / tokens / latency. Metric collection itself is out of scope for this spec.

## Motivation

The current `crm-builder` chat workflow uses an Agent Team for COMPLEX requests: developers, reviewers, and a shared merger all live in one team, communicate via `SendMessage`, and the orchestrator polls merger reports through `wait-for-team-merges.sh`. We want to test whether the same workflow expressed with standard subagents (no team, no peer-to-peer messaging) produces different cost / latency / quality numbers.

The change must keep the work observably the same (same git output, same UX) so the comparison isolates the coordination mechanism rather than confounding it with other variables.

## Architecture

### Principle

All agents become one-shot: invoked via `Agent({run_in_background: true})`, each returns a structured plain-text result that the orchestrator parses from the tool result. No peer-to-peer messaging, no team scheduling, no inbox.

### Async event-driven orchestration

The orchestrator drives the wave by reacting to background-agent completion notifications:

1. Dispatch all N developers in parallel (background), end turn.
2. Each developer completion fires a background turn for the orchestrator.
3. In each background turn the orchestrator parses the just-finished agent's output, advances the per-ticket state, dispatches the next agent(s) for that ticket (background), and ends turn again.
4. The wave ends when every ticket is in a terminal state (`DONE` or `FAILED`).

This is the same async event-driven shape as the Agent Team flow, but the coordination layer is the runtime's background-completion notification instead of team scheduling + inbox.

### Per-ticket pipeline independence

Because each ticket's next dispatch happens on its own developer's completion, pipelines run independently. Ticket A's reviewers start as soon as A's developer finishes — they do not wait for ticket B's developer. Parallelism matches the Agent Team baseline.

### Tools available to chat-orchestrator

Removed: `TeamCreate`, `TeamDelete`, `SendMessage`.
Kept: `Agent`, `Skill`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`.

## State machine (per ticket)

The orchestrator maintains a per-ticket state table reconstructed from its conversation context at each background turn — the source of truth is the sequence of past Agent tool results. No sidecar state file.

```
TASK-XXX: {
  stage: "DEV" | "REVIEW" | "MERGE" | "DONE" | "FAILED",
  retries: 0..2,
  dev_output: "DONE: branch=... commit=... files=[...]" | null,
  reviews: { quality: "APPROVED" | "REJECTED: ..." | null,
             test:    "APPROVED" | "REJECTED: ..." | null }
}
```

Transitions (each one driven by exactly one background turn):

| Trigger | Action |
|---|---|
| DEV returns `DONE: ...` | stage → REVIEW; dispatch `quality-reviewer` + `test-validator` in parallel (background) |
| DEV returns `FAILED: ...` | stage → FAILED |
| One reviewer returns a verdict | store it; if the other reviewer is still pending, wait |
| Both reviewers `APPROVED` | stage → MERGE; dispatch `merger` for this ticket (background) |
| At least one `REJECTED` and `retries < 2` | stage → DEV; `retries += 1`; re-dispatch `developer` with the same worktree + `RETRY_FEEDBACK=<concatenated reviewer feedback>` |
| At least one `REJECTED` and `retries == 2` | stage → FAILED |
| MERGE returns `DONE: ...` | stage → DONE |
| MERGE returns `FAILED: ...` | stage → FAILED |
| All tickets in `{DONE, FAILED}` | emit final user-facing reply, run POST-DEV check |

### Merger parallelism

The merger runs `git merge` against `/app`, which holds `.git/index.lock`. We dispatch one merger per ticket in parallel — the filesystem lock serialises them naturally. This is simpler than the Agent Team's shared-merger approach and produces equivalent output.

### Safety bounds

- `MAX_RETRIES = 2` per ticket (so up to 3 developer attempts).
- Hard cap of 50 orchestrator background turns per wave. Past that, abort the wave and reply `"Travail bloqué"` in the user's language.
- Wave size cap `N ≤ 5` preserved from the current orchestrator. If the planner emits a wave with more than 5 tickets, take the first 5 for this pass and resume with the leftover on the next user turn.
- Malformed agent output (does not match `DONE: ...` / `FAILED: ...` / `APPROVED` / `REJECTED: ...`) is treated as `FAILED` for the corresponding stage.

**Known limitation (deferred):** The SubagentStop validation chain (typecheck/prettier/unit/e2e) iterates all active session worktrees rather than scoping to the stopping subagent's worktree. With parallel developers this can produce false-negative stops when another developer's worktree is mid-write. If the benchmark exposes contamination, address by parsing the SubagentStop stdin's prompt to set `VALIDATE_WORKTREE`.

## Agent output formats

Each agent terminates with one structured text line that the orchestrator parses by regex.

| Agent | Success output | Failure output |
|---|---|---|
| `planner` | (unchanged — produces ticket JSON files) | `FAILED: <reason>` |
| `developer` | `DONE: branch=<X> commit=<sha> files=[<paths>]` | `FAILED: <reason>` |
| `quality-reviewer` | `APPROVED` | `REJECTED: <bullets of issues>` |
| `test-validator` | `APPROVED` | `REJECTED: <bullets of issues>` |
| `merger` | `DONE: TASK-XXX commit=<sha>` | `FAILED: TASK-XXX <reason>` |
| `simple-developer` | (unchanged — already `DONE: ...` / `FAILED: ...`) | — |

### Developer retry contract

When the orchestrator re-dispatches a developer after a rejection, the prompt includes:

- The original ticket spec path.
- The same `WORKTREE_PATH` and `BRANCH_NAME` (worktree persists between attempts; the developer keeps the existing branch and adds new commits).
- `RETRY_FEEDBACK=<verbatim text from both reviewers' REJECTED bodies>`.

The developer reads the feedback, applies fixes, re-commits, and returns a fresh `DONE: ...` line.

### Reviewer contract

Reviewers receive the worktree path in the prompt. They read the diff directly from the worktree (no SendMessage handshake with the developer). They return exactly `APPROVED` or `REJECTED:` followed by structured bullets describing what must change.

## File-by-file changes

### Agents (`claudeConfig/.claude/agents/`)

| File | Changes |
|---|---|
| `chat-orchestrator.md` | Full rewrite of STATE B (event-driven background turns). Remove tools `TeamCreate` / `TeamDelete` / `SendMessage` from frontmatter. Remove every `Skill({skill: "agent-team"})` invocation. STATE SETUP-PLAN feeds the new STATE B (no other adaptation). |
| `developer.md` | Remove the SendMessage(reviewer/merger) protocol. Define the `DONE: ...` / `FAILED: ...` output contract. Add: read `RETRY_FEEDBACK` from the spawn prompt when present and apply targeted fixes. |
| `quality-reviewer.md` | Remove SendMessage. Read the worktree from the spawn prompt path. Output `APPROVED` or `REJECTED: <bullets>`. |
| `test-validator.md` | Same as `quality-reviewer.md`. |
| `merger.md` | Drop the team-mode column entirely. Spawn prompt provides `TASK_ID`, `BRANCH_NAME`, `WORKTREE_PATH`. Output `DONE: TASK-XXX commit=<sha>` or `FAILED: TASK-XXX <reason>`. Keep the existing variant-restore logic. |
| `simple-developer.md` | Unchanged. |
| `planner.md`, `architect.md`, `documentator.md`, `devops.md` | Unchanged. |

### Skills (`claudeConfig/.claude/skills/`)

- `agent-team/` → delete the directory.
- All other skills (`e2e-conventions`, `playwright-testing`, `reflection-writing`, `setup-interview`, `shadcn-customization`, `worktree-detection`) → unchanged.

### Hooks and settings (`claudeConfig/.claude/settings.json`, `claudeConfig/.claude/hooks/`)

Remove these hooks and (where they exist) their script files:

- `member-idle-gate.sh` — gated team-member tool calls; no team, no need.
- `teamdelete-gate.sh`, `teamdelete-cleanup.sh` — no `TeamDelete` ever called.
- `block-premature-shutdowns.sh` — gated SendMessage shutdowns; no SendMessage.

Convert one hook:

- `validate-before-review.sh` — currently a `PreToolUse / SendMessage` gate that runs typecheck + prettier + unit + e2e before the developer can hand off to a reviewer. Re-wire it as a `SubagentStop` hook on matcher `developer` (mirroring how `simple-developer` already gates its stop on the same checks). The retry loop owned by the orchestrator now plays the role the blocked SendMessage used to play: if validation fails the developer's stop is rejected, the developer's internal loop fixes the issue, and only a green stop returns `DONE:` to the orchestrator.

Keep unchanged (orthogonal to teams):

- `setup-worktree.sh` (SubagentStart on `developer` and `simple-developer`).
- `cleanup-worktree.sh` (SubagentStop on `merger`).
- `silent-mode-check.sh`, `circuit-breaker.sh`, `block-bash-file-write.sh`, `block-bash-validation.sh`, `block-orchestrator-merge.sh`, `restrict-documentator-bash.sh`, `restrict-documentator-write.sh`.

### Scripts

- `wait-for-team-merges.sh` (under `claudeConfig/.claude/hooks/`) → delete.

### Out of scope (unchanged)

- `chat-service/` — the stats already collected (`tokensUsed`, `total_cost_usd`, `activeAgents`, turn counts in `meta.json` / `log.jsonl`) are sufficient for the eventual benchmark. No instrumentation to add.
- `entrypoint.sh`, `Dockerfile`, `supervisord.conf`, `docker-compose.yml`, `app-variants/`.

## Non-goals

- No new agents or new agent roles.
- No new skills.
- No new metrics infrastructure (the user handles benchmark collection separately).
- No changes to SIMPLE, MEMORY, MODE-SWITCH, SETUP-INTERVIEW flows (they already don't use Agent Team; only SETUP-PLAN's downstream STATE B is touched by the rewrite, automatically).
- No changes to the planner output format or ticket schema.

## Success criteria

A COMPLEX multi-ticket prompt run against `test-noAgentTeam` produces git output (merged commits, branches, files) semantically equivalent to the same prompt run against the `crm-builder` baseline, with zero calls to `TeamCreate` / `TeamDelete` / `SendMessage` from the chat-orchestrator.
