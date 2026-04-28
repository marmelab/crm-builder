# Agent-teams E2E — simple mode

**Date:** 2026-04-28
**Container:** `atomic-crm-validate` (image `atomic-crm-dev:validate-2026-04-28-agent-teams`, working tree at HEAD `a8ff47b`)
**Session:** `151970ae-e8fd-40d5-b16c-2519bf521936`
**Claude session id:** `6fa7926f-47ed-4175-8dcd-bf7e6b84288c`
**Prompt:** `Renomme le label "Hot Contacts" du dashboard en "VIP Contacts"`
**Duration:** ~170s (07:57:41Z → 08:00:31Z)

## Outcome

**Functional success with 3 protocol regressions to fix.**

The label was renamed and merged to master:

```
f9b1211 chore(ticket-TASK-001): merge rename Hot Contacts to VIP Contacts
5701323 feat: rename Hot Contacts to VIP Contacts on dashboard
8beff9f Initial commit (from marmelab/atomic-crm main)
```

Final user-facing message: *"C'est fait ! Le label "Hot Contacts" a été renommé en "VIP Contacts" sur le tableau de bord."*

## Regressions found

### R-1 — `SendMessage to: name@team` rejected by runtime

The new skill v2 protocol uses `to: "developer@ticket-TASK-001"` (etc.) per Phase 0 finding W1b. The runtime rejects this with:

```
<tool_use_error>to must be a bare teammate name — there is only one team per session</tool_use_error>
```

The orchestrator naturally fell back to the bare form `to: "developer"` and the message was delivered. **But the skill's documented protocol is incorrect** and needs revision. Phase 0 W1b had observed `team-lead@<team>` working for the *outgoing* leg (teammate → lead), but it does not work for the *incoming* leg (lead → teammate, or peer → peer). Same for `developer@team`, `merger@team`, etc.

**Fix:** rewrite the skill (and dispatch prompts in agent files) to use bare names everywhere — `developer`, `quality-reviewer`, `test-validator`, `merger`, `team-lead` — since "there is only one team per session" enforces uniqueness within the lead's namespace.

### R-2 — `TeamDelete({})` called with empty input

The orchestrator emitted two `TeamDelete` tool_uses with `input: {}`:

```
{"name":"TeamDelete","input":{}}
{"name":"TeamDelete","input":{}}
```

Neither did anything useful. `ticket-TASK-001` is still present in `/home/developer/.claude/teams/` after the run.

**Fix:** the new skill's Phase 3 cleanup must be explicit: `TeamDelete({team_name: "ticket-TASK-XXX"})`. The current skill text shows the form but the orchestrator generalized to "TeamDelete and forget".

### R-3 — Cleanup Bash filename pattern doesn't match reality

The skill's Phase 3 cleanup runs:

```
rm -f /home/developer/.claude/projects/-app/$SID/subagents/agent-developer@$TEAM.{jsonl,meta.json}
rm -f /home/developer/.claude/projects/-app/$SID/subagents/agent-merger@$TEAM.{jsonl,meta.json}
```

But the real files are named `agent-<task_id>.jsonl` (e.g. `agent-a4707f06db04f6f7f.jsonl`). The `task_id` is the Claude Code internal id, not the `name@team` format. The cleanup is therefore a no-op, leaving 8 subagent transcripts orphaned per run.

**Fix:** Phase 3 cleanup must either (a) glob `agent-*.jsonl` filtered by `mtime` of this run, or (b) use the `task_id`s discovered during the run, or (c) wipe the entire `subagents/` dir for this `$CLAUDE_SESSION_ID` after the merger replies.

Option (c) is simplest:
```bash
rm -rf /home/developer/.claude/projects/-app/$CLAUDE_SESSION_ID/subagents/
```
(everything in `subagents/` belongs to subagents of THIS lead session, so global wipe is safe.)

## Cleanup verification

| Item | Status | Notes |
|---|---|---|
| Worktree `/worktrees/TASK-001` | ✅ removed | `git worktree remove` succeeded (merger executed correctly) |
| Feature branch | ✅ deleted | `git branch -d feat/task-001-rename-hot-contacts` succeeded |
| Merge commit at HEAD | ✅ `f9b1211` | merger formed the commit message correctly |
| Team config `ticket-TASK-001` | ❌ leaked | R-2 — TeamDelete called with empty input |
| Subagent transcripts (8 files) | ❌ leaked | R-3 — wrong filename pattern |
| `$CLAUDE_SESSION_ID` injection | ✅ working | The cleanup Bash referenced it correctly via env (Phase 4 task 4.2 verified end-to-end) |

## Hook activations

The new `PreToolUse / SendMessage` hook (`validate-before-review.sh`) was registered (Phase 3) but did NOT fire on this run because **the developer did not send a SendMessage to a reviewer or merger** — the dev was spawned in simple mode with NO reviewers, and on completion the developer used `SendMessage(merger, ...)` which would have triggered the hook... but the dev's first SendMessage attempt hit the `name@team` rejection (R-1). When it retried with bare name `merger`, the hook fired and ran the validation chain (typecheck, prettier, etc). All passed silently — the merge then succeeded.

So the hook works as designed; the simple flow just doesn't exercise it heavily.

## Observations

- **Latency**: 170s end-to-end is reasonable for a simple-mode flow with 2 agents.
- **`run_in_background: true`** was set on both `Agent` calls (developer + merger), letting the lead emit them in parallel and return to the foreground for `SendMessage`. The new peer-to-peer flow appears to rely on this implicitly.
- **Orchestrator behavior**: created a TASK-001 ticket file (`/chat-service/logs/<sid>/TASK-001.json`) even for simple mode. The skill says simple mode = inline prompt only, but the orchestrator generalized. Not blocking.
- **ABORT detour**: after merge succeeded, the orchestrator sent `ABORT` SendMessages to dev and merger before doing cleanup. This was probably triggered by confusion from the R-1 errors. With R-1 fixed, this detour should disappear.

## Recommended next steps before complex-mode run

1. Fix R-1 (bare names in skill + agent prompts) — prevents protocol error noise in complex run.
2. Fix R-2 (`TeamDelete({team_name: ...})` explicit in Phase 3) — required for clean teardown.
3. Fix R-3 (cleanup uses `rm -rf <subagents>/` or task_id glob) — required for state-free reruns.

These are 3 small Edits in `claudeConfig/.claude/skills/agent-team/SKILL.md`. Estimated 10 min, then re-run simple to verify zero regressions before paying for complex.
