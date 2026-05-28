# No-Agent-Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the COMPLEX/SETUP wave workflow in `test-noAgentTeam` to use standard one-shot subagents (`Agent({run_in_background: true})`) instead of the Agent Team primitive (`TeamCreate` / `team_name` / `SendMessage`), so the two coordination mechanisms can be benchmarked head-to-head.

**Architecture:** The chat-orchestrator drives an async event-driven loop: dispatch agents in the background, react to each completion notification in a background turn, advance a per-ticket state machine, redispatch developers on review rejection (max 2 retries), dispatch a merger per ticket when both reviewers approve. Agent outputs are structured plain-text lines (`DONE: ...`, `APPROVED`, `REJECTED: ...`) parsed by the orchestrator.

**Tech Stack:** Claude Code agents (markdown with YAML frontmatter), shell hooks, JSON settings, bash scripts. No code changes to `chat-service/` — existing stats infrastructure captures the comparison.

---

## File Structure

**Modified:**
- `claudeConfig/.claude/agents/chat-orchestrator.md` — full STATE B rewrite, frontmatter tool list, STATE A and STATE SETUP-PLAN cleanup
- `claudeConfig/.claude/agents/developer.md` — drop SendMessage protocol, define `DONE:`/`FAILED:` output, handle `RETRY_FEEDBACK`
- `claudeConfig/.claude/agents/quality-reviewer.md` — drop SendMessage, output `APPROVED` / `REJECTED:`
- `claudeConfig/.claude/agents/test-validator.md` — same as quality-reviewer
- `claudeConfig/.claude/agents/merger.md` — unify on one mode (no team variant), structured output per ticket
- `claudeConfig/.claude/settings.json` — remove team-related hooks, re-wire `validate-before-review.sh` as `SubagentStop` on developer

**Deleted:**
- `claudeConfig/.claude/skills/agent-team/` (directory)
- `claudeConfig/.claude/hooks/wait-for-team-merges.sh`
- `claudeConfig/.claude/hooks/member-idle-gate.sh`
- `claudeConfig/.claude/hooks/teamdelete-gate.sh`
- `claudeConfig/.claude/hooks/teamdelete-cleanup.sh`
- `claudeConfig/.claude/hooks/block-premature-shutdowns.sh`

**Untouched:** all other agents (`planner.md`, `architect.md`, `simple-developer.md`, `documentator.md`, `devops.md`), `chat-service/`, `entrypoint.sh`, `Dockerfile`, all other skills, all other hooks.

---

### Task 1: Simplify `merger.md` — single output contract

**Files:**
- Modify: `claudeConfig/.claude/agents/merger.md`

The merger currently has two modes (TEAM via SendMessage, SIMPLE via plain return). Collapse to a single mode that returns a plain-text line. The merger receives `TASK_ID`, `BRANCH_NAME`, `WORKTREE_PATH` in its spawn prompt for every dispatch.

- [ ] **Step 1: Read the current file to map sections**

Run: `Read claudeConfig/.claude/agents/merger.md`

Locate: the WORKFLOW section, any column or branch that distinguishes "TEAM" from "SIMPLE", any references to `SendMessage`, any references to `team_name`.

- [ ] **Step 2: Remove the tool `SendMessage` from frontmatter `tools:` if present**

In the YAML frontmatter at the top, remove the `- SendMessage` line. Keep: `Bash`, `Read`, `Grep`, `Glob`.

- [ ] **Step 3: Replace the dual-mode WORKFLOW with a single-mode WORKFLOW**

The new prompt contract:
- Spawn prompt provides `TASK_ID`, `BRANCH_NAME`, `WORKTREE_PATH`.
- For COMPLEX wave dispatches it also provides `TICKETS_DIR` (the directory holding the ticket JSON files) so the merger can update the ticket's `status` field.
- For SIMPLE-mode dispatches `TASK_ID` is the literal string `SIMPLE` and `TICKETS_DIR` is absent — the merger skips the ticket status update.
- Output on success: exactly one line — `DONE: <TASK_ID> commit=<short_sha>` (where `<TASK_ID>` may be `SIMPLE`).
- Output on failure: exactly one line — `FAILED: <TASK_ID> <reason>`.
- No `SendMessage` calls anywhere.

Insert this section near the top of the WORKFLOW (after any role/preamble):

```markdown
## OUTPUT CONTRACT (required)

Your very last line of output MUST be exactly one of:

- `DONE: <TASK_ID> commit=<short_sha>`
- `FAILED: <TASK_ID> <one-line reason>`

`<TASK_ID>` is the value passed in the spawn prompt (e.g. `TASK-003` or the literal `SIMPLE` for the SIMPLE flow). Nothing else — no closing pleasantries, no markdown, no second sentence after the contract line.

The orchestrator parses this line by regex. Any other format is treated as `FAILED`.
```

Remove every paragraph that references `SendMessage`, `team_name`, the "team-lead" address, or the dual TEAM/SIMPLE table columns. Keep all the git-merge mechanics (the `git merge --no-ff`, the variant-restore step, the lock-retry loop if present).

- [ ] **Step 4: Verify no leftover team references**

Run: `grep -nE 'SendMessage|team_name|team-lead' claudeConfig/.claude/agents/merger.md`
Expected: no output (empty result, exit code 1).

- [ ] **Step 5: Commit**

```bash
cd /home/jerome/Work/crm-builder-root/test-noAgentTeam
git add claudeConfig/.claude/agents/merger.md
git commit -m "refactor(merger): single output contract, drop SendMessage"
```

---

### Task 2: Rewrite `quality-reviewer.md` — output contract, no messaging

**Files:**
- Modify: `claudeConfig/.claude/agents/quality-reviewer.md`

- [ ] **Step 1: Read the current file**

Run: `Read claudeConfig/.claude/agents/quality-reviewer.md`

Identify: SendMessage protocol section (how reviewer signals back to dev or merger), any `team_name` references, the section describing what the reviewer reads (worktree path).

- [ ] **Step 2: Remove `SendMessage` from `tools:` in frontmatter**

Keep: `Read`, `Grep`, `Glob`, `Bash` (and any others). Remove only `SendMessage`.

- [ ] **Step 3: Replace the SendMessage handshake with the output contract**

Insert near the top of WORKFLOW:

```markdown
## OUTPUT CONTRACT (required)

Your very last line of output MUST be exactly one of:

- `APPROVED`
- `REJECTED: <feedback>`

For `REJECTED:`, `<feedback>` is a bulleted list (one bullet per issue) the developer must address on retry. Be specific: file path + symptom + what to change. The developer's next attempt receives this verbatim as `RETRY_FEEDBACK`.

Nothing else after the contract line — no pleasantries, no markdown trailer.

The orchestrator parses this line by regex. Any other format is treated as `REJECTED: <malformed reviewer output>`.
```

Remove every paragraph that references `SendMessage`, `team_name`, "ready for review" handshake, or any cross-agent messaging.

- [ ] **Step 4: Confirm the reviewer reads the worktree from the spawn prompt**

The spawn prompt provides `WORKTREE_PATH`. The reviewer reviews the diff in that worktree (no inbox handshake required). If the existing prompt already describes this, keep it; if it describes a SendMessage-gated start, simplify to: *"Read the diff in `WORKTREE_PATH` (provided in your spawn prompt). Apply your review checklist. Emit the contract line."*

- [ ] **Step 5: Verify**

Run: `grep -nE 'SendMessage|team_name|team-lead' claudeConfig/.claude/agents/quality-reviewer.md`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add claudeConfig/.claude/agents/quality-reviewer.md
git commit -m "refactor(quality-reviewer): APPROVED/REJECTED output contract, drop SendMessage"
```

---

### Task 3: Rewrite `test-validator.md` — same shape as quality-reviewer

**Files:**
- Modify: `claudeConfig/.claude/agents/test-validator.md`

Identical surgery to Task 2, but for the test-validator agent. The output contract is the same (`APPROVED` / `REJECTED: <feedback>`).

- [ ] **Step 1: Read the file**

Run: `Read claudeConfig/.claude/agents/test-validator.md`

- [ ] **Step 2: Remove `SendMessage` from frontmatter `tools:`**

- [ ] **Step 3: Insert the OUTPUT CONTRACT section near the top of WORKFLOW**

Paste the exact same block as Task 2 Step 3:

```markdown
## OUTPUT CONTRACT (required)

Your very last line of output MUST be exactly one of:

- `APPROVED`
- `REJECTED: <feedback>`

For `REJECTED:`, `<feedback>` is a bulleted list (one bullet per issue) the developer must address on retry. Be specific: file path + symptom + what to change. The developer's next attempt receives this verbatim as `RETRY_FEEDBACK`.

Nothing else after the contract line — no pleasantries, no markdown trailer.

The orchestrator parses this line by regex. Any other format is treated as `REJECTED: <malformed reviewer output>`.
```

- [ ] **Step 4: Remove SendMessage paragraphs**

Same as Task 2 Step 3 (the second part). Keep the test-validator's domain logic (what it actually checks — e2e presence, integration wiring); only strip the messaging plumbing.

- [ ] **Step 5: Verify**

Run: `grep -nE 'SendMessage|team_name|team-lead' claudeConfig/.claude/agents/test-validator.md`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add claudeConfig/.claude/agents/test-validator.md
git commit -m "refactor(test-validator): APPROVED/REJECTED output contract, drop SendMessage"
```

---

### Task 4: Rewrite `developer.md` — output contract + RETRY_FEEDBACK handling

**Files:**
- Modify: `claudeConfig/.claude/agents/developer.md`

- [ ] **Step 1: Read the file**

Run: `Read claudeConfig/.claude/agents/developer.md`

Identify: SendMessage protocol (typically dev → reviewer "ready", dev → merger "approved"), `team_name` mentions, the WORKFLOW order (setup → implement → test → commit → message).

- [ ] **Step 2: Remove `SendMessage` from frontmatter `tools:`**

Keep: `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`. Remove `SendMessage`.

- [ ] **Step 3: Insert the OUTPUT CONTRACT section near the top of WORKFLOW**

```markdown
## OUTPUT CONTRACT (required)

Your very last line of output MUST be exactly one of:

- `DONE: branch=<branch_name> commit=<short_sha> files=[<comma-separated paths>]`
- `FAILED: <one-line reason>`

Nothing else after the contract line — no pleasantries, no markdown trailer.

The orchestrator parses this line by regex. Any other format is treated as `FAILED`.
```

- [ ] **Step 4: Insert the RETRY_FEEDBACK section right after the OUTPUT CONTRACT**

```markdown
## RETRY MODE (when RETRY_FEEDBACK is present in your spawn prompt)

If your spawn prompt contains a `RETRY_FEEDBACK=...` block, you are on a retry attempt. The worktree already exists with your previous commits on the branch — do NOT re-create it, do NOT re-init the branch.

1. Read the bullets in `RETRY_FEEDBACK` carefully. They come from `quality-reviewer` and/or `test-validator` and describe issues with your previous attempt.
2. Apply targeted fixes only for the listed issues. Do not refactor unrelated code.
3. Run the same local validation steps as a fresh attempt (typecheck, prettier, the relevant unit tests, e2e if the change is UI-visible).
4. `git commit` the fixes on the same branch (additive commits — no rebase, no squash).
5. Emit the OUTPUT CONTRACT line with the new HEAD commit sha.

If you cannot resolve the feedback (e.g. test infrastructure broken, missing context), emit `FAILED: <reason citing the unresolvable feedback>`.
```

- [ ] **Step 5: Remove every SendMessage paragraph**

Remove any "send a message to your reviewer", "tell the merger", "team-lead handshake" paragraphs and their surrounding scaffolding. The dev's final act is `git commit` + emit the contract line. The orchestrator handles all downstream dispatch.

- [ ] **Step 6: Verify**

```bash
grep -nE 'SendMessage|team_name|team-lead' claudeConfig/.claude/agents/developer.md
# expected: no output

grep -nE 'OUTPUT CONTRACT|RETRY_FEEDBACK' claudeConfig/.claude/agents/developer.md
# expected: at least 2 matches (the two headers)
```

- [ ] **Step 7: Commit**

```bash
git add claudeConfig/.claude/agents/developer.md
git commit -m "refactor(developer): DONE/FAILED output contract + RETRY_FEEDBACK handling"
```

---

### Task 5: Re-wire hooks in `settings.json`

**Files:**
- Modify: `claudeConfig/.claude/settings.json`

Two structural changes:
1. Remove the `PreToolUse` matchers for `SendMessage` and `TeamDelete`, and the `PostToolUse` matcher for `TeamDelete`, and remove `member-idle-gate.sh` from the `Bash|Read|Grep|Glob|SendMessage` matcher (also remove `SendMessage` from that matcher's pattern).
2. Add `validate-before-review.sh` (renamed-in-spirit, same script) plus the validation chain (typecheck, prettier, unit-app, unit-functions, e2e) to `SubagentStop` on matcher `developer` — mirroring the existing `simple-developer` SubagentStop.

- [ ] **Step 1: Read the file**

Run: `Read claudeConfig/.claude/settings.json`

- [ ] **Step 2: Replace the `hooks` object with the cleaned-up version**

Replace the entire `"hooks": { ... }` block (lines 27-187 in the current file) with the following content. The wrapping fields (`enabledPlugins`, `env`, `permissions`, `attribution`, etc.) are unchanged.

```json
    "hooks": {
        "PreToolUse": [
            {
                "matcher": "Bash",
                "hooks": [
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/silent-mode-check.sh"
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/circuit-breaker.sh"
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/block-bash-file-write.sh"
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/block-bash-validation.sh"
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/block-orchestrator-merge.sh"
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/restrict-documentator-bash.sh"
                    }
                ]
            },
            {
                "matcher": "Write|Edit",
                "hooks": [
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/restrict-documentator-write.sh"
                    }
                ]
            }
        ],
        "SubagentStart": [
            {
                "matcher": "simple-developer|developer",
                "hooks": [
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/setup-worktree.sh",
                        "timeout": 60,
                        "statusMessage": "Setting up worktree..."
                    }
                ]
            }
        ],
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/turn-complete.sh",
                        "timeout": 5
                    }
                ]
            }
        ],
        "SubagentStop": [
            {
                "matcher": "merger",
                "hooks": [
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/cleanup-worktree.sh",
                        "timeout": 30,
                        "statusMessage": "Cleaning up worktree..."
                    }
                ]
            },
            {
                "matcher": "simple-developer|developer",
                "hooks": [
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/typecheck-on-commit.sh",
                        "timeout": 120,
                        "statusMessage": "Validating typecheck..."
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/prettier-on-stop.sh",
                        "timeout": 60,
                        "statusMessage": "Validating prettier..."
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/run-unit-tests-app.sh",
                        "timeout": 180,
                        "statusMessage": "Running unit tests (app)..."
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/run-unit-tests-functions.sh",
                        "timeout": 180,
                        "statusMessage": "Running unit tests (functions)..."
                    },
                    {
                        "type": "command",
                        "command": "/home/developer/.claude/hooks/run-e2e-tests.sh",
                        "timeout": 600,
                        "statusMessage": "Running e2e tests..."
                    }
                ]
            }
        ]
    }
```

Note the two key changes vs. the current file:
- `PreToolUse / Bash|Read|Grep|Glob|SendMessage` (member-idle-gate) → removed entirely.
- `PreToolUse / SendMessage` (block-premature-shutdowns + validate-before-review) → removed entirely.
- `PreToolUse / TeamDelete` (teamdelete-gate) → removed entirely.
- `PostToolUse / TeamDelete` (teamdelete-cleanup) → removed entirely.
- `SubagentStop` matcher for the validation chain changes from `simple-developer` to `simple-developer|developer` (the validation chain now also gates `developer`'s stop — playing the role that `validate-before-review.sh` used to play on `SendMessage`).

- [ ] **Step 3: Validate JSON syntax**

Run: `jq . claudeConfig/.claude/settings.json > /dev/null && echo "valid"`
Expected: `valid`

- [ ] **Step 4: Confirm no orphan references**

```bash
grep -nE 'member-idle-gate|teamdelete|block-premature-shutdowns|validate-before-review' claudeConfig/.claude/settings.json
# expected: no output
```

- [ ] **Step 5: Commit**

```bash
git add claudeConfig/.claude/settings.json
git commit -m "config: remove team-related hooks, gate developer stop on validation chain"
```

---

### Task 6: Delete dead files

**Files:**
- Delete: `claudeConfig/.claude/skills/agent-team/` (whole directory)
- Delete: `claudeConfig/.claude/hooks/wait-for-team-merges.sh`
- Delete: `claudeConfig/.claude/hooks/member-idle-gate.sh`
- Delete: `claudeConfig/.claude/hooks/teamdelete-gate.sh`
- Delete: `claudeConfig/.claude/hooks/teamdelete-cleanup.sh`
- Delete: `claudeConfig/.claude/hooks/block-premature-shutdowns.sh`
- Delete: `claudeConfig/.claude/hooks/validate-before-review.sh`

The `validate-before-review.sh` script's job (run typecheck + prettier + unit + e2e before reviewer/merger handoff) is now done by the existing SubagentStop chain wired in Task 5. The script itself is dead. The same scripts (`typecheck-on-commit.sh`, `prettier-on-stop.sh`, `run-unit-tests-*.sh`, `run-e2e-tests.sh`) are reused — no new scripts needed.

- [ ] **Step 1: Remove the skill directory and the dead hook scripts**

```bash
cd /home/jerome/Work/crm-builder-root/test-noAgentTeam
git rm -r claudeConfig/.claude/skills/agent-team
git rm claudeConfig/.claude/hooks/wait-for-team-merges.sh
git rm claudeConfig/.claude/hooks/member-idle-gate.sh
git rm claudeConfig/.claude/hooks/teamdelete-gate.sh
git rm claudeConfig/.claude/hooks/teamdelete-cleanup.sh
git rm claudeConfig/.claude/hooks/block-premature-shutdowns.sh
git rm claudeConfig/.claude/hooks/validate-before-review.sh
```

- [ ] **Step 2: Verify no other file references the deleted scripts**

```bash
grep -rnE 'wait-for-team-merges|member-idle-gate|teamdelete-(gate|cleanup)|block-premature-shutdowns|validate-before-review|skills/agent-team' claudeConfig/ entrypoint.sh chat-service/ 2>/dev/null
# expected: matches only inside chat-orchestrator.md (not yet rewritten — Task 8 fixes this) — no matches in any other file
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete agent-team skill and dead team hooks"
```

---

### Task 7: Strip `chat-orchestrator.md` frontmatter and SIMPLE-only flow references

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md`

This task is a surgical cleanup of the parts of the orchestrator that are NOT the COMPLEX wave loop. STATE B (the heart) is rewritten in Task 8.

- [ ] **Step 1: Edit the frontmatter `tools:` block**

In the YAML frontmatter at the top of the file:

```yaml
tools:
  - Agent
  - TeamCreate
  - TeamDelete
  - Skill
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - SendMessage
```

Replace with:

```yaml
tools:
  - Agent
  - Skill
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
```

- [ ] **Step 2: Remove every `Skill({skill: "agent-team"})` invocation in the file**

Locate every paragraph or step that says `Skill({skill: "agent-team"})` (or paraphrases the same). Remove the whole invocation. Where the surrounding prose says "Invoke the agent-team skill" or "load the team workflow", remove that line too. Nothing replaces it — STATE B documents the new workflow inline (added in Task 8).

- [ ] **Step 3: In STATE SETUP-PLAN, update the planner dispatch to the unchanged form**

The planner dispatch itself doesn't change. Just ensure no `Skill({skill: "agent-team"})` precedes it. The planner output still feeds STATE B on the next turn.

- [ ] **Step 4: Verify**

```bash
grep -nE 'TeamCreate|TeamDelete|SendMessage|"agent-team"|team_name' claudeConfig/.claude/agents/chat-orchestrator.md
# expected: only matches that fall inside STATE B (still the old version, will be rewritten in Task 8).
# Nothing should appear in STATE A, STATE SETUP-PLAN, frontmatter, SIMPLE/MEMORY/MODE-SWITCH flows.
```

- [ ] **Step 5: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "refactor(chat-orchestrator): strip team tools and agent-team skill calls outside STATE B"
```

---

### Task 8: Rewrite STATE B in `chat-orchestrator.md`

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md`

The heart of the change. The current STATE B (multi-turn wave loop with `wait-for-team-merges.sh` polling, team teardown phase 3, etc.) is deleted and replaced with the event-driven background-dispatch loop.

- [ ] **Step 1: Locate STATE B in the file**

Run: `grep -n '^### STATE B' claudeConfig/.claude/agents/chat-orchestrator.md`
Note the line number. STATE B runs from that line until the next `^###` (probably `### STATE DONE` or `## POST-DEV`).

- [ ] **Step 2: Delete the entire STATE B section and replace with the block below**

Replace the section from `### STATE B — ...` (exclusive end at the next `###` heading) with:

````markdown
### STATE B — WAVE DISPATCH (event-driven, background subagents)

For COMPLEX (and the next turn after STATE SETUP-PLAN).

The planner's output is in your context. Parse it: pick the **first wave** (tickets with `dependencies: []`). Get the list of `TASK-XXX` ids + branch_names. **Wave size cap: N ≤ 5.** If the wave contains more than 5 tickets, take only the first 5; the remainder becomes a new wave on the next user turn.

**Mental state table (kept in your conversation context, reconstructed from past tool results):**

```
TASK-XXX: {
  stage: "DEV" | "REVIEW" | "MERGE" | "DONE" | "FAILED",
  retries: 0..2,
  dev_output: "DONE: branch=... commit=... files=[...]" | null,
  reviews: { quality: "APPROVED" | "REJECTED: ..." | null,
             test:    "APPROVED" | "REJECTED: ..." | null }
}
```

#### Step 1 — Initial dispatch (initial user turn)

For each of the N tickets, in ONE assistant message:

```
Agent({
  subagent_type: "developer",
  description: "Implement TASK-XXX",
  prompt: "ROLE: developer\nTICKET_ID: TASK-XXX\nTICKET_SPEC: <absolute path to ticket json>\nWORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX\nBRANCH_NAME: <SESSION_SHORT_ID>/<branch_name>",
  run_in_background: true
})
```

After the N developer dispatches, emit one short user-facing status line (in the user's language), e.g. *"Working on it..."*, and end the turn.

Initialize the mental state: every ticket starts at `{stage: "DEV", retries: 0}`.

#### Step 2 — React to each background-agent completion

Each completion of a background agent fires a new background turn for you. In that turn:

1. Identify which agent just finished (look at the most recent tool result in your context).
2. Parse its last line against the contract for its role:
   - developer: `DONE: branch=... commit=... files=[...]` or `FAILED: ...`
   - quality-reviewer / test-validator: `APPROVED` or `REJECTED: ...`
   - merger: `DONE: TASK-XXX commit=...` or `FAILED: TASK-XXX ...`
   - any other shape → treat as `FAILED` for that role.
3. Update the mental state for the relevant ticket per the transitions below.
4. Dispatch the next agent(s) for that ticket (background, in the same assistant message), or — if no more dispatches are needed for any ticket — go to Step 3.
5. Emit a short status text only when crossing a milestone the user cares about (one ticket merged, one ticket failed). Use the translation table from the previous STATE B (e.g. *"Sessions feature done — moving to the next step."*). Otherwise, end the turn silently (with a single-character text if your client needs one).

#### Transitions

| Trigger | Mental state update | Next dispatch |
|---|---|---|
| developer of T returns `DONE` | `T.stage = REVIEW`; `T.dev_output = <line>` | `Agent({subagent_type: "quality-reviewer", description: "Quality review T", prompt: "ROLE: quality-reviewer\nTICKET_ID: T\nWORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/T", run_in_background: true})` AND `Agent({subagent_type: "test-validator", ...})` — both in the same message |
| developer of T returns `FAILED` | `T.stage = FAILED` | none |
| 1 reviewer of T returns a verdict | store in `T.reviews.{quality|test}` | wait for the other reviewer |
| both reviewers of T = `APPROVED` | `T.stage = MERGE` | `Agent({subagent_type: "merger", description: "Merge T", prompt: "ROLE: merger\nTASK_ID: T\nBRANCH_NAME: <SESSION_SHORT_ID>/<branch>\nWORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/T\nTICKETS_DIR: <absolute path>", run_in_background: true})` |
| at least 1 reviewer of T = `REJECTED` and `T.retries < 2` | `T.stage = DEV`; `T.retries += 1`; clear `T.reviews` | re-dispatch developer with the same prompt PLUS `RETRY_FEEDBACK=<concatenation of both reviewers' REJECTED bodies, "quality:" then "test:">` |
| at least 1 reviewer of T = `REJECTED` and `T.retries == 2` | `T.stage = FAILED` | none |
| merger of T returns `DONE` | `T.stage = DONE` | none |
| merger of T returns `FAILED` | `T.stage = FAILED` | none |

#### Step 3 — Wave done (all tickets in `{DONE, FAILED}`)

When every ticket of the wave is in a terminal state:

1. Decide whether more waves remain (planner output may have other waves with `dependencies: [TASK-XXX]`).
2. If more waves remain → reply per-ticket success/failure in business language, and **end the turn**. The next user turn (or any user message) will trigger another STATE B for the next wave.
3. If this was the last wave:
   - SETUP path (planner was given `SETUP_MODE=true`) → go directly to STATE SETUP-DONE in this same turn.
   - COMPLEX path → run the POST-DEV check (`Bash("pending-deploys ${TICKETS_DIR}")`), then reply per-ticket. If pending deploys, append the PD-ASK question and enter STATE PD-ASK; otherwise enter STATE DONE.

#### Safety bounds

- `MAX_RETRIES = 2` per ticket (3 attempts total). Past that → `FAILED`.
- Hard cap: **50 background turns** in STATE B per wave. Past that, reply *"The work stalled — I'll need to start over on the unfinished pieces."* and enter STATE DONE.
- Count your background turns by inspecting your conversation history (number of background turns since the initial Step 1 turn).
````

- [ ] **Step 3: Verify STATE B no longer references team mechanics**

```bash
# Inside the STATE B section specifically:
awk '/^### STATE B/,/^### |^## POST-DEV/' claudeConfig/.claude/agents/chat-orchestrator.md \
  | grep -nE 'TeamCreate|TeamDelete|SendMessage|team_name|wait-for-team-merges'
# expected: no output
```

- [ ] **Step 4: Verify whole file is clean**

```bash
grep -nE 'TeamCreate|TeamDelete|SendMessage|team_name|"agent-team"|wait-for-team-merges' claudeConfig/.claude/agents/chat-orchestrator.md
# expected: no output
```

- [ ] **Step 5: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "refactor(chat-orchestrator): rewrite STATE B as event-driven background-subagent loop"
```

---

### Task 9: End-to-end smoke test

**Files:** none (verification only)

The goal: spin up the chat-service, send a COMPLEX prompt that exercises a multi-ticket wave, and confirm the new orchestrator produces merged commits without ever calling `TeamCreate` / `TeamDelete` / `SendMessage`.

- [ ] **Step 1: Build and start the demo profile**

```bash
cd /home/jerome/Work/crm-builder-root/test-noAgentTeam
docker compose --profile demo up -d --build
```

Wait until `crm-frontend` and `chat-service` are healthy (`docker compose ps`).

- [ ] **Step 2: Pick a known-good COMPLEX prompt**

A representative prompt that the baseline `crm-builder` handles in 2 tickets. Example: *"Add an Importance field on companies and surface it in the company list filter."*

- [ ] **Step 3: Submit the prompt via the chat UI**

Open `http://localhost:5173` (or whichever port the demo serves), open the chat panel, send the prompt.

Watch the chat-service logs:

```bash
docker compose logs -f chat-service
```

- [ ] **Step 4: Observe the workflow**

You should see in the logs:
- A `planner` subagent dispatch (foreground or background).
- N developer subagent dispatches in parallel (background).
- For each developer that returns `DONE: ...`, two reviewer subagent dispatches (background).
- For each pair of approved reviewers, a merger dispatch.
- No `TeamCreate`, no `TeamDelete`, no `SendMessage` events in the log stream.
- Final user-facing reply listing the merged tickets.

- [ ] **Step 5: Verify no team primitives were used in this session**

Find the session log:

```bash
ls -1t sessions/ | head -3
# pick the most recent session dir
SESSION_DIR=sessions/<most-recent>
grep -E '"tool_name":"(TeamCreate|TeamDelete|SendMessage)"' $SESSION_DIR/log.jsonl
# expected: no output (zero team-tool invocations)
```

- [ ] **Step 6: Verify git output looks plausible**

```bash
cd crm-source
git log --oneline -10
# expected: merge commits for each successful ticket, all on the session branch or main per the merger's policy
```

- [ ] **Step 7: Capture cost and tokens for the session (for later benchmarking by the user)**

```bash
cat $SESSION_DIR/meta.json | jq '{costUsd, tokensUsed, activeAgents}'
```

No commit (this task is verification only). If anything looks wrong (e.g., team primitives appeared, tickets stuck in DEV with no completion notifications), open an issue note and triage before declaring success.

---

## Self-Review

**Spec coverage:**
- "Replace TeamCreate / SendMessage with run_in_background" → Tasks 7, 8.
- Output contracts (`DONE: ...`, `APPROVED`, `REJECTED: ...`, etc.) → Tasks 1-4.
- State machine + transitions → Task 8.
- MAX_RETRIES = 2, hard cap 50 turns, wave cap 5, malformed-output handling → Task 8.
- RETRY_FEEDBACK contract → Task 4 + Task 8.
- Delete `agent-team` skill → Task 6.
- Delete team hooks and `wait-for-team-merges.sh` → Task 6.
- Convert `validate-before-review.sh` → SubagentStop on developer → Task 5.
- Keep worktree hooks, validation scripts, orthogonal hooks → Task 5 (preserved structure).
- No changes to chat-service, entrypoint, planner/architect/devops/documentator, simple-developer → respected (no task touches them).
- Success criterion (zero team-tool invocations in a session) → Task 9 Step 5.

**Placeholders:** none — every step has actual content, every file path is concrete, every grep / jq command is runnable.

**Type consistency:**
- `TASK_ID` used consistently across merger, orchestrator dispatch prompt, and ticket spec.
- `WORKTREE_PATH`, `BRANCH_NAME` used consistently across developer, reviewers, merger spawn prompts (orchestrator Task 8 dispatches them; agents Tasks 1-4 expect them).
- `TICKETS_DIR` passed only to merger (for status update) and not to reviewers/developer — intentional, matches current convention.
- Mental-state field names (`stage`, `retries`, `dev_output`, `reviews.quality`, `reviews.test`) used consistently in Task 8.
