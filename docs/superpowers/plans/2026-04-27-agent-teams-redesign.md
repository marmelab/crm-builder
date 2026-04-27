# Agent-Teams Real Peer-to-Peer Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current hub-and-spoke orchestration (chat-orchestrator brokers every message) with real peer-to-peer agent-team communication: dev↔reviewers in direct fix-cycles, lead spawn-and-forget, deterministic `name@team` IDs, deterministic transcript cleanup at end-of-team.

**Architecture:** All ticket agents (developer, quality-reviewer, test-validator, merger) are spawned upfront by the lead with `name:` field for predictable `name@team` IDs. Each gets `SendMessage` in its tools. Dev is the pivot: counts approvals (P3), notifies all reviewers on each fix (R1), runs Mode 2 reflection (K1), then SendMessages merger. Merger pings lead at end. Lead does filesystem cleanup of subagent transcripts (TeamDelete only handles team-config dirs, not transcripts). Validation moves from 5 SubagentStop hooks (one per script) to a single PreToolUse / SendMessage hook that gates fix→review handoff.

**Tech Stack:** Claude Code 2.1.118 with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` ; Node 22 ESM (chat-service) ; bash hooks ; markdown agent definitions ; jq for JSON parsing in hooks.

**Spec de référence:** [docs/superpowers/specs/2026-04-27-agent-teams-redesign-design.md](../specs/2026-04-27-agent-teams-redesign-design.md)

---

## Safety notes

- **Phase 0 is gating.** Do NOT commit any prod code (skill, agents, hooks, server.js) until Q1-Q4 from the spec are validated empirically. If any answer differs from the design assumptions, revise the spec/plan first.
- **Hook `stop-hook-error` (seen in session de4b5b2b)** must be root-caused before Phase 3 ships, otherwise the new PreToolUse hook will inherit the same crash mode silently.
- **Filesystem cleanup paths** (`/home/developer/.claude/projects/-app/<sid>/subagents/`) are **inside the Docker container**. The lead's Bash tool runs inside the container too (cwd=/app), so paths resolve correctly. Don't use `/home/jerome/...` host paths in hooks/agents.
- **Agent-teams is `EXPERIMENTAL`.** Capture the version (2.1.118) in commit messages and the validation findings doc. If Anthropic changes behavior, this plan needs revisiting.
- **The chat-service queue locks turns.** While a team is running, no new user message can interleave. Don't try to handle concurrent tickets in this iteration.

## File Structure

**New files:**

- `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` — Phase 0 findings (Q1-Q4 answers, version, raw test logs).
- `claudeConfig/.claude/hooks/validate-before-review.sh` — Phase 3 PreToolUse hook script.
- `claudeConfig/.claude/hooks/test/validate-before-review.test.sh` — Phase 3 bash tests for the hook.
- `docs/superpowers/runs/2026-04-27-agent-teams-e2e-simple.md` — Phase 6 simple-mode test trace + analysis.
- `docs/superpowers/runs/2026-04-27-agent-teams-e2e-complex.md` — Phase 6 complex-mode test trace + analysis.

**Modified files:**

- `claudeConfig/.claude/skills/agent-team/SKILL.md` — Phase 1 full rewrite for the new flow.
- `claudeConfig/.claude/agents/developer.md` — Phase 2: add `SendMessage` to tools, update protocol section.
- `claudeConfig/.claude/agents/quality-reviewer.md` — Phase 2: same.
- `claudeConfig/.claude/agents/test-validator.md` — Phase 2: same + change `model: haiku` → `model: sonnet`.
- `claudeConfig/.claude/agents/merger.md` — Phase 2: same.
- `claudeConfig/.claude/agents/chat-orchestrator.md` — Phase 2: rewrite the orchestration section for new spawn-and-forget flow.
- `claudeConfig/.claude/settings.json` — Phase 3: remove 5 `SubagentStop / matcher: developer` hooks, add 1 `PreToolUse / matcher: SendMessage` hook.
- `chat-service/server.js` — Phase 4: pass `CLAUDE_SESSION_ID` env var to the spawned `claude -p` process.
- `chat-service/test/server-spawn.test.js` — Phase 4 (new test file).
- `chat-service/lib/stats.js` — Phase 5 OPTIONAL: index by `task_id` instead of `tool_use_id`, group activations.
- `chat-service/test/stats.test.js` — Phase 5 OPTIONAL: extend with SendMessage-resume fixture.
- `chat-service/test/fixtures/sendmessage-resume.jsonl` — Phase 5 OPTIONAL: new fixture mimicking de4b5b2b structure.
- `CLAUDE.md` — Phase 7: doc update for new agent-team architecture.

**Kept (referenced from new hook):**

- `claudeConfig/.claude/hooks/typecheck-on-commit.sh`
- `claudeConfig/.claude/hooks/prettier-on-stop.sh`
- `claudeConfig/.claude/hooks/run-unit-tests-app.sh`
- `claudeConfig/.claude/hooks/run-unit-tests-functions.sh`
- `claudeConfig/.claude/hooks/run-e2e-tests.sh`

These remain as-is; the new `validate-before-review.sh` invokes them in sequence.

---

## Phase 0 — Empirical validation (gating)

Run all 4 probes inside the running `atomic-crm-demo` container. No prod code commits until done. Findings get written into `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` and committed at the end.

### Task 0.1: Set up the validation findings document

**Files:**
- Create: `docs/superpowers/runs/2026-04-27-agent-teams-validation.md`

- [ ] **Step 1:** Create the findings doc skeleton.

```bash
mkdir -p docs/superpowers/runs
cat > docs/superpowers/runs/2026-04-27-agent-teams-validation.md <<'EOF'
# Agent-teams runtime validation

**Date:** 2026-04-27
**Claude Code version:** 2.1.118 (verify with `claude --version` in container)
**Spec:** [docs/superpowers/specs/2026-04-27-agent-teams-redesign-design.md](../specs/2026-04-27-agent-teams-redesign-design.md)

## Q1 — How does the lead receive a SendMessage from a teammate?

(filled in Task 0.2)

## Q2 — Does `subagent_type + name` produce `name@team` agentId?

(filled in Task 0.3)

## Q3 — Is `CLAUDE_SESSION_ID` accessible to the lead?

(filled in Task 0.4)

## Q4 — Why do hooks crash with `stop-hook-error`?

(filled in Task 0.5)

## Decision

Go / no-go for the redesign. (filled at the end)
EOF
```

- [ ] **Step 2:** Verify the file exists.

```bash
ls -la docs/superpowers/runs/2026-04-27-agent-teams-validation.md
```

Expected: file exists, ~25 lines.

### Task 0.2: Probe Q1 — lead-receives-SendMessage mechanism

**Files:**
- Modify: `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` (fill Q1)

- [ ] **Step 1:** Verify the demo container is running with the chat-service container active.

```bash
docker ps --format '{{.Names}}' | grep '^atomic-crm-demo$' || echo "MISSING — start with docker compose --profile demo up -d"
```

Expected: `atomic-crm-demo` listed. If missing, start it.

- [ ] **Step 2:** Write the probe prompt to the container.

```bash
cat > /tmp/q1-probe-prompt.txt <<'EOF'
Controlled probe. Follow EXACTLY and report verbatim.

GOAL: see how the lead is notified when a teammate SendMessages back.

STEPS:
1. TeamCreate({team_name: "q1probe", description: "exp"})
2. Spawn a teammate that will reply to the lead:
   Agent({
     subagent_type: "general-purpose",
     team_name: "q1probe",
     name: "echoer",
     description: "echoer",
     prompt: "When you receive a SendMessage from team-lead, reply to team-lead@q1probe with the literal text 'ECHO_OK'. Then stop."
   })
   Capture the agentId returned.
3. ToolSearch select:SendMessage to load schema.
4. SendMessage({to: "<echoer agentId>", message: "Please echo."})
5. Wait via Bash({command: "sleep 5"}) so the teammate has time to run.
6. Now: report what you observe in your context. Specifically:
   - Did you receive an event of type "task_notification" or similar mentioning the echoer's reply?
   - Did you receive the literal text "ECHO_OK" anywhere in your tool results or system events?
   - Did you have to do anything explicit (TaskOutput? read inbox?) to see the reply?
7. TeamDelete({team_name: "q1probe"})

Report block:
PROBE_REPORT
- echoer_agent_id: <id>
- sendmessage_send_result: <verbatim>
- mechanism_observed: text describing what events/tools surfaced the reply (W1=automatic, W2=had to poll TaskOutput or read inbox, W3=other)
- echo_text_seen: yes/no
- did_you_call_taskoutput: yes/no
- did_you_read_inbox_file: yes/no
END_REPORT
EOF
docker cp /tmp/q1-probe-prompt.txt atomic-crm-demo:/tmp/q1-probe-prompt.txt
```

- [ ] **Step 3:** Run the probe inside the container as the developer user.

```bash
docker exec -u developer atomic-crm-demo bash -c '
mkdir -p /tmp/q1probe
TS=$(date +%s)
PROMPT=$(cat /tmp/q1-probe-prompt.txt)
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 timeout 180 claude \
  --output-format stream-json --verbose --dangerously-skip-permissions --model sonnet \
  -p "$PROMPT" > /tmp/q1probe/run-$TS.jsonl 2> /tmp/q1probe/run-$TS.err
echo "EXIT=$?"
echo "FILE=/tmp/q1probe/run-$TS.jsonl"
'
```

Expected: EXIT=0, file size > 10kB.

- [ ] **Step 4:** Pull the log to host and extract the report + system events that mention the echoer.

```bash
docker cp atomic-crm-demo:/tmp/q1probe /tmp/q1probe
LATEST=$(ls -t /tmp/q1probe/run-*.jsonl | head -1)
echo "Reading $LATEST"
echo "=== final REPORT block ==="
jq -r 'select(.type == "result") | .result' "$LATEST"
echo "=== events mentioning the echoer's task_id (post-SendMessage) ==="
jq -c 'select(.type == "system" or (.type == "user" and (.message.content | tostring | test("ECHO_OK|echoer"))))' "$LATEST"
```

- [ ] **Step 5:** Fill the Q1 section in the findings doc with the verbatim observations.

Edit `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` and replace the `## Q1` placeholder with:

```markdown
## Q1 — How does the lead receive a SendMessage from a teammate?

**Probe:** TeamCreate + spawn echoer + SendMessage(echoer, "echo") + sleep 5 + observe.

**Run log:** `/tmp/q1probe/run-<ts>.jsonl` (in container).

**Mechanism observed:** [W1 / W2 / W3] — describe what surfaced the reply.

**Verbatim PROBE_REPORT:**

(paste verbatim REPORT block from the run)

**Implication for the design:**
- If W1: spec Section 4.1 stays as-is; lead's prompt requires no special "wait" instruction.
- If W2: spec Section 4.1 needs a "TaskOutput polling" instruction in the lead's prompt; document the polling cadence.
- If W3: document the actual mechanism here; revise spec accordingly.
```

- [ ] **Step 6:** Verify the doc was updated.

```bash
grep -A 5 "## Q1 " docs/superpowers/runs/2026-04-27-agent-teams-validation.md | head -15
```

### Task 0.3: Probe Q2 — `subagent_type + name` agentId format

**Files:**
- Modify: `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` (fill Q2)

- [ ] **Step 1:** Write the probe prompt.

```bash
cat > /tmp/q2-probe-prompt.txt <<'EOF'
Controlled probe. Follow EXACTLY and report verbatim.

GOAL: determine the agentId format when a NAMED subagent_type is spawned with a `name:` field.

STEPS:
1. TeamCreate({team_name: "q2probe", description: "exp"})
2. Spawn the developer agent WITH name: field:
   Agent({
     subagent_type: "developer",
     team_name: "q2probe",
     name: "developer",
     description: "test probe (do nothing)",
     prompt: "You are a probe. Reply with the literal text PROBE2_OK and nothing else. Do not use any tool."
   })
   Capture the EXACT agentId returned (it appears in the result text "agentId: <id> (use SendMessage with to: '<id>'...").
3. ALSO note any "agent_id" or "lead_agent_id" mentioned in the TeamCreate result.
4. Read the team config: Read({file_path: "/home/developer/.claude/teams/q2probe/config.json"}).
5. TeamDelete (force if needed: SendMessage shutdown_request first if blocked).

Report block:
PROBE_REPORT
- developer_agentId_in_result: <verbatim string from "agentId: ...">
- format_is_name_at_team: yes / no
- team_config_members_section: <verbatim members array from config.json>
END_REPORT
EOF
docker cp /tmp/q2-probe-prompt.txt atomic-crm-demo:/tmp/q2-probe-prompt.txt
```

- [ ] **Step 2:** Run the probe.

```bash
docker exec -u developer atomic-crm-demo bash -c '
TS=$(date +%s)
PROMPT=$(cat /tmp/q2-probe-prompt.txt)
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 timeout 120 claude \
  --output-format stream-json --verbose --dangerously-skip-permissions --model sonnet \
  -p "$PROMPT" > /tmp/q1probe/q2-$TS.jsonl 2> /tmp/q1probe/q2-$TS.err
echo "EXIT=$?  FILE=/tmp/q1probe/q2-$TS.jsonl"
'
```

- [ ] **Step 3:** Extract findings.

```bash
docker cp atomic-crm-demo:/tmp/q1probe/q2-*.jsonl /tmp/q1probe/ 2>&1 | tail -3
LATEST=$(ls -t /tmp/q1probe/q2-*.jsonl | head -1)
jq -r 'select(.type == "result") | .result' "$LATEST"
```

- [ ] **Step 4:** Fill Q2 in findings doc.

Replace the `## Q2` section with verbatim probe report. Then add:

```markdown
**Implication:**
- If `developer@q2probe` (name@team format): design proceeds as planned. All ticket agents get deterministic IDs.
- If hex random: must use `general-purpose + name:` instead, abandoning per-role frontmatter (model/tools/system prompt) — major design change. Revise spec before continuing.
```

- [ ] **Step 5:** Decision check.

If the agentId is hex (NOT `name@team`), **STOP** and discuss with user before continuing. Do not proceed to Phase 1.

### Task 0.4: Probe Q3 — `CLAUDE_SESSION_ID` accessibility

**Files:**
- Modify: `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` (fill Q3)

- [ ] **Step 1:** Inspect what env vars Claude Code exposes to its agents.

```bash
docker exec -u developer atomic-crm-demo bash -c '
TS=$(date +%s)
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 timeout 60 claude \
  --output-format stream-json --verbose --dangerously-skip-permissions --model sonnet \
  -p "Run the bash command: env | grep -iE \"claude|session\" | sort. Report the output verbatim. No other commentary." \
  > /tmp/q1probe/q3-$TS.jsonl 2>&1
echo "EXIT=$?"
'
```

- [ ] **Step 2:** Extract result.

```bash
docker cp atomic-crm-demo:/tmp/q1probe/q3-*.jsonl /tmp/q1probe/ 2>&1 | tail -2
LATEST=$(ls -t /tmp/q1probe/q3-*.jsonl | head -1)
jq -r 'select(.type == "result") | .result' "$LATEST"
```

- [ ] **Step 3:** Inspect the chat-service spawn code to see what envs it currently passes.

```bash
grep -n "spawn\|claude.*-p\|env:" chat-service/server.js | head -20
```

- [ ] **Step 4:** Fill Q3 in findings doc.

```markdown
## Q3 — Is `CLAUDE_SESSION_ID` accessible to the lead?

**Probe:** `env | grep -iE "claude|session"` from a test agent.

**Vars seen:** (paste output)

**Available natively:** YES / NO

**Implication for cleanup:**
- If YES: hook scripts and the lead's cleanup Bash can reference `$CLAUDE_SESSION_ID` directly.
- If NO: chat-service must inject it. Phase 4 Task 4.2 is required.
```

### Task 0.5: Probe Q4 — `stop-hook-error` root cause

**Files:**
- Modify: `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` (fill Q4)

- [ ] **Step 1:** Re-run one of the existing hooks manually with `bash -x` and a fake stdin matching what SubagentStop sends.

```bash
# First: capture an actual SubagentStop stdin shape from de4b5b2b session
grep -B0 -A0 'SubagentStop\|subagent_stop' /home/jerome/Work/crm-builder/sessions/de4b5b2b-2fec-47f6-86aa-cb16ee6238a1/log.jsonl 2>/dev/null | head -3 || echo "No literal SubagentStop in log; use synthetic stdin"

# Synthetic stdin (typical SubagentStop payload):
SYNTHETIC_STDIN='{"hook_event_name":"SubagentStop","stop_hook_active":true,"transcript_path":"/tmp/x.jsonl","cwd":"/app","tool_name":null,"matcher":"developer"}'
echo "$SYNTHETIC_STDIN" | docker exec -i atomic-crm-demo bash -x /home/developer/.claude/hooks/typecheck-on-commit.sh 2>&1 | tail -30
```

- [ ] **Step 2:** Try the same with each of the 5 hook scripts. Note the exit codes and any stderr.

```bash
for h in typecheck-on-commit.sh prettier-on-stop.sh run-unit-tests-app.sh run-unit-tests-functions.sh run-e2e-tests.sh; do
  echo "=== $h ==="
  echo "$SYNTHETIC_STDIN" | docker exec -i atomic-crm-demo bash -x /home/developer/.claude/hooks/$h 2>&1 | tail -5
  echo ""
done
```

- [ ] **Step 3:** Check the hooks.log for entries from the de4b5b2b session timeframe.

```bash
docker exec atomic-crm-demo bash -c "grep '2026-04-27T12:0[5-9]' /chat-service/logs/hooks.log 2>/dev/null | head -20 || echo 'no entries from that timeframe'"
```

- [ ] **Step 4:** Look at the entrypoint and supervisord configs for any hooks-related setup that might be missing.

```bash
docker exec atomic-crm-demo bash -c 'ls -la /home/developer/.claude/hooks/ ; ls -la /entrypoint.sh /entrypoint-helpers/ 2>/dev/null | head -20'
```

- [ ] **Step 5:** Fill Q4 with the observed root cause.

```markdown
## Q4 — Why do hooks crash with `stop-hook-error`?

**Test:** synthetic SubagentStop stdin piped to each hook script with `bash -x`.

**Observed errors:**
- `typecheck-on-commit.sh`: (exit code, stderr summary)
- `prettier-on-stop.sh`: ...
- ... (5 scripts)

**Root cause:** (e.g., "missing `set -e` mishandling", "node not in PATH", "$CLAUDE_PROJECT_DIR unset", etc.)

**Fix:** (small fix to apply before Phase 3, OR document that the new `validate-before-review.sh` must avoid this issue).
```

- [ ] **Step 6:** If a quick fix is identified for the existing scripts AND it's < 5 lines change, apply it inline. Otherwise, defer the fix to be folded into the new `validate-before-review.sh` (Phase 3).

### Task 0.6: Decide go/no-go and commit Phase 0 findings

**Files:**
- Modify: `docs/superpowers/runs/2026-04-27-agent-teams-validation.md` (final Decision section)

- [ ] **Step 1:** Review all 4 answers in the findings doc. Determine if any block the design.

Blockers:
- Q2 returns hex IDs (not name@team) → STOP, discuss with user
- Q1 mechanism is wildly different from W1/W2/W3 → STOP, discuss with user

Non-blockers (fixable in plan):
- Q3 NO (must inject) → Phase 4 task already covers it
- Q4 root cause identified → fix in Phase 3

- [ ] **Step 2:** Fill the Decision section.

```markdown
## Decision

**Go / No-go:** GO / NO-GO

**Notes:** (e.g., "W1 confirmed; name@team confirmed; CLAUDE_SESSION_ID requires injection (Phase 4); stop-hook-error caused by X, fix integrated into validate-before-review.sh.")
```

- [ ] **Step 3:** Commit the findings doc.

```bash
git add docs/superpowers/runs/2026-04-27-agent-teams-validation.md
git commit -m "$(cat <<'EOF'
docs(runs): Phase 0 validation for agent-teams redesign

Empirical findings for Q1-Q4 from the spec. Validates the lead-receives-
SendMessage mechanism, the name@team agentId format with named subagent_types,
CLAUDE_SESSION_ID accessibility, and the root cause of stop-hook-error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 — Skill `agent-team` v2 rewrite

Rewrite `claudeConfig/.claude/skills/agent-team/SKILL.md` for the new flow. The skill is the single source of truth invoked by every team member at startup.

### Task 1.1: Backup current skill and draft the new structure

**Files:**
- Modify: `claudeConfig/.claude/skills/agent-team/SKILL.md`

- [ ] **Step 1:** Create a backup of the current skill (in case we need to reference its content).

```bash
cp claudeConfig/.claude/skills/agent-team/SKILL.md /tmp/agent-team-SKILL-old.md
wc -l /tmp/agent-team-SKILL-old.md  # for reference
```

- [ ] **Step 2:** Replace the skill content with the new structure (skeleton first, sections to be filled in subsequent tasks).

```bash
cat > claudeConfig/.claude/skills/agent-team/SKILL.md <<'SKILL_EOF'
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

- **Simple mode:** developer + merger only (2 agents). No reviewers, no Mode 2 reflection.
- **Complex mode:** developer + quality-reviewer + test-validator + merger (4 agents). Mode 2 reflection between all-APPROVED and SendMessage merger.

(Classification logic added by Task 1.6.)

## Phase 1 — Team setup (lead only)

(Filled by Task 1.2)

## Phase 2 — Per-agent protocols

(Filled by Task 1.3)

## Phase 3 — Cleanup (lead only)

(Filled by Task 1.4)

## Failure paths

(Filled by Task 1.5)

## Reference: name@team IDs

For team_name `ticket-TASK-XXX`, the predictable agent IDs are:

- `team-lead@ticket-TASK-XXX` — the chat-orchestrator (auto-registered as lead by TeamCreate)
- `developer@ticket-TASK-XXX`
- `quality-reviewer@ticket-TASK-XXX` (complex mode only)
- `test-validator@ticket-TASK-XXX` (complex mode only)
- `merger@ticket-TASK-XXX`

These IDs are deterministic and known by every team member at spawn time (passed in their initial prompt).
SKILL_EOF
echo "SKILL.md skeleton written: $(wc -l < claudeConfig/.claude/skills/agent-team/SKILL.md) lines"
```

- [ ] **Step 3:** Verify file is valid markdown and contains the expected sections.

```bash
grep -E '^## ' claudeConfig/.claude/skills/agent-team/SKILL.md
```

Expected output:
```
## TL;DR
## When to use
## Modes
## Phase 1 — Team setup (lead only)
## Phase 2 — Per-agent protocols
## Phase 3 — Cleanup (lead only)
## Failure paths
## Reference: name@team IDs
```

### Task 1.2: Fill section "Phase 1 — Team setup"

**Files:**
- Modify: `claudeConfig/.claude/skills/agent-team/SKILL.md` (replace the Phase 1 placeholder)

- [ ] **Step 1:** Replace the "Phase 1 — Team setup (lead only)" placeholder with the spawn instructions.

Use the Edit tool to replace this exact block:

```
## Phase 1 — Team setup (lead only)

(Filled by Task 1.2)
```

with:

````
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
````

- [ ] **Step 2:** Verify the section was filled.

```bash
sed -n '/^## Phase 1 — Team setup/,/^## /p' claudeConfig/.claude/skills/agent-team/SKILL.md | head -50
```

### Task 1.3: Fill section "Phase 2 — Per-agent protocols"

**Files:**
- Modify: `claudeConfig/.claude/skills/agent-team/SKILL.md` (replace the Phase 2 placeholder)

- [ ] **Step 1:** Replace the "Phase 2 — Per-agent protocols" placeholder with the per-role protocols.

Use the Edit tool to replace:

```
## Phase 2 — Per-agent protocols

(Filled by Task 1.3)
```

with:

````
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
````

- [ ] **Step 2:** Verify the file structure.

```bash
grep -E '^### ' claudeConfig/.claude/skills/agent-team/SKILL.md
```

Expected:
```
### developer@ticket-TASK-XXX
### quality-reviewer@ticket-TASK-XXX
### test-validator@ticket-TASK-XXX
### merger@ticket-TASK-XXX
```

### Task 1.4: Fill section "Phase 3 — Cleanup"

**Files:**
- Modify: `claudeConfig/.claude/skills/agent-team/SKILL.md` (replace the Phase 3 placeholder)

- [ ] **Step 1:** Replace the Phase 3 placeholder.

Use the Edit tool to replace:

```
## Phase 3 — Cleanup (lead only)

(Filled by Task 1.4)
```

with:

````
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
````

- [ ] **Step 2:** Verify.

```bash
sed -n '/^## Phase 3 — Cleanup/,/^## /p' claudeConfig/.claude/skills/agent-team/SKILL.md | head -40
```

### Task 1.5: Fill section "Failure paths"

**Files:**
- Modify: `claudeConfig/.claude/skills/agent-team/SKILL.md` (replace the Failure paths placeholder)

- [ ] **Step 1:** Replace the placeholder.

Use the Edit tool to replace:

```
## Failure paths

(Filled by Task 1.5)
```

with:

````
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
````

- [ ] **Step 2:** Verify.

```bash
sed -n '/^## Failure paths/,/^## Reference/p' claudeConfig/.claude/skills/agent-team/SKILL.md | head -40
```

### Task 1.6: Fill the TL;DR, Modes, and When to use sections

**Files:**
- Modify: `claudeConfig/.claude/skills/agent-team/SKILL.md`

- [ ] **Step 1:** Replace the `## Modes` section.

Edit the file: replace

```
## Modes

- **Simple mode:** developer + merger only (2 agents). No reviewers, no Mode 2 reflection.
- **Complex mode:** developer + quality-reviewer + test-validator + merger (4 agents). Mode 2 reflection between all-APPROVED and SendMessage merger.

(Filled by Task 1.2)
```

with the same first two lines (no longer with the placeholder), plus a sub-section explaining how the lead chooses:

```
## Modes

- **Simple mode:** developer + merger only (2 agents). No reviewers, no Mode 2 reflection. Used for one-shot UI tweaks ("rename label X to Y", "hide button Z"), single-file edits, no test impact.
- **Complex mode:** developer + quality-reviewer + test-validator + merger (4 agents). Mode 2 reflection between all-APPROVED and SendMessage merger. Used for multi-file features, anything touching data flow, anything affecting tests, anything ambiguous.

The lead classifies in its first turn based on the user request. The default for ambiguous cases is **complex** (false positives are cheap, missed reviews are not).
```

- [ ] **Step 2:** Verify the file is complete (no remaining "Filled by" placeholders).

```bash
grep -n "(Filled by" claudeConfig/.claude/skills/agent-team/SKILL.md
```

Expected: no output (all placeholders replaced).

- [ ] **Step 3:** Run a sanity check on the markdown structure.

```bash
wc -l claudeConfig/.claude/skills/agent-team/SKILL.md
grep -c '^## ' claudeConfig/.claude/skills/agent-team/SKILL.md
grep -c '^### ' claudeConfig/.claude/skills/agent-team/SKILL.md
```

Expected: ~280-330 lines, 8 H2 sections, 4 H3 sections (the per-agent protocols).

### Task 1.7: Commit Phase 1

- [ ] **Step 1:** Stage and commit.

```bash
git add claudeConfig/.claude/skills/agent-team/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skill): rewrite agent-team skill for peer-to-peer flow

Replaces the hub-and-spoke orchestration playbook with the peer-to-peer
flow described in the spec:
- Lead spawns 4 agents upfront with name@team IDs, sends ONE go message
- Dev↔reviewers fix-cycles directly (no orchestrator broker)
- Dev counts approvals (P3), re-notifies all on each fix (R1)
- Mode 2 reflection inside dev between APPROVED and SendMessage merger
- Lead does deterministic filesystem cleanup of subagent transcripts

Per-role protocols (developer/quality-reviewer/test-validator/merger)
spelled out as the agents' canonical reference. Failure paths covered:
timeouts, fix-cycle non-convergence, merger conflict, abort path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Agent definitions update

Update each ticket-team agent's frontmatter to add `SendMessage` in their tools, and update their prompt body to align with the skill v2 protocol.

### Task 2.1: developer.md

**Files:**
- Modify: `claudeConfig/.claude/agents/developer.md`

- [ ] **Step 1:** Inspect the current frontmatter to know exactly what to change.

```bash
sed -n '1,15p' claudeConfig/.claude/agents/developer.md
```

- [ ] **Step 2:** Edit the frontmatter `tools:` list to include `SendMessage`. Use Edit tool to add `  - SendMessage` to the YAML list under `tools:`. Place it after the existing tools, e.g.:

```yaml
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
  - Skill
  - SendMessage   # <-- ADD THIS
```

- [ ] **Step 3:** Replace the prompt's "workflow" section with the new protocol from the skill (Task 1.3 developer block). Search for the existing flow description (likely "Phase 1 — Plan", "Phase 2 — Implement", etc., or a "Workflow" section), and replace it with a brief pointer to the skill:

```markdown
## Workflow

You are a team member of `ticket-TASK-XXX` (passed via your spawn prompt). On startup, invoke `Skill({skill: "agent-team"})` and follow the **developer protocol** in Section "Phase 2".

Key responsibilities:
- Read the ticket, implement in the worktree, commit
- (complex mode) Notify quality-reviewer@... and test-validator@... when ready
- (simple mode) Notify merger@... directly
- Apply R1 on any BLOCKED: re-notify ALL reviewers after a fix
- Run Mode 2 reflection (complex mode only) before SendMessaging merger

**Critical**: never SendMessage anyone outside your team. The teammates list comes from your spawn prompt.
```

- [ ] **Step 4:** Verify the edit.

```bash
grep -E "SendMessage|^## Workflow" claudeConfig/.claude/agents/developer.md | head
```

Expected: `SendMessage` appears in tools, `## Workflow` section exists.

### Task 2.2: quality-reviewer.md

**Files:**
- Modify: `claudeConfig/.claude/agents/quality-reviewer.md`

- [ ] **Step 1:** Inspect current frontmatter.

```bash
sed -n '1,15p' claudeConfig/.claude/agents/quality-reviewer.md
```

- [ ] **Step 2:** Add `SendMessage` to `tools:` list (same pattern as Task 2.1 Step 2).

- [ ] **Step 3:** Replace the prompt's workflow section with:

```markdown
## Workflow

You are a team member of `ticket-TASK-XXX`. On startup, invoke `Skill({skill: "agent-team"})` and follow the **quality-reviewer protocol** in Section "Phase 2".

Key responsibilities:
- Wait for SendMessage from developer@... ("ready, please review")
- Read the ticket and the worktree diff
- Apply rules from `.claude/rules/coding-style.md`, `.claude/rules/agent-output-format.md`, scan `.claude/rules/security-triggers.md` for flagging
- Reply with verdict: SendMessage(developer@..., "APPROVED") OR "BLOCKED: <list>"
- Wait for next message (dev's fix), re-review

**Do not**: run validations (typecheck/e2e — handled by PreToolUse hook), SendMessage other reviewers or merger, spawn agents.
```

- [ ] **Step 4:** Verify.

```bash
grep -E "SendMessage|^## Workflow" claudeConfig/.claude/agents/quality-reviewer.md | head
```

### Task 2.3: test-validator.md (model upgrade + protocol)

**Files:**
- Modify: `claudeConfig/.claude/agents/test-validator.md`

- [ ] **Step 1:** Inspect current frontmatter and note the existing model.

```bash
sed -n '1,15p' claudeConfig/.claude/agents/test-validator.md
```

Expected current: `model: haiku`.

- [ ] **Step 2:** Use Edit tool to change `model: haiku` to `model: sonnet`.

- [ ] **Step 3:** Add `SendMessage` to `tools:` list (same as Task 2.1 Step 2).

- [ ] **Step 4:** Replace the prompt's workflow section with:

```markdown
## Workflow

You are a team member of `ticket-TASK-XXX`. On startup, invoke `Skill({skill: "agent-team"})` and follow the **test-validator protocol** in Section "Phase 2".

Key responsibilities:
- Wait for SendMessage from developer@... ("ready, please validate")
- Read the worktree, the ticket, and any new test files
- Verify TEST PRESENCE: every new behavior in the diff has at least one corresponding test (unit/e2e per `.claude/rules/testing.md` and `.claude/skills/e2e-conventions`)
- Verify TEST PERTINENCE: judge whether the assertions actually cover the failure modes that matter (e.g. assertions that always pass are not pertinent)
- Reply: SendMessage(developer@..., "APPROVED") OR "BLOCKED: <list>"

**Do not**: run the tests yourself (the PreToolUse hook on the dev side does that), SendMessage other reviewers or merger.
```

- [ ] **Step 5:** Verify the model change took effect.

```bash
grep -E "^model:|SendMessage" claudeConfig/.claude/agents/test-validator.md | head
```

Expected: `model: sonnet`, `SendMessage` in tools.

### Task 2.4: merger.md

**Files:**
- Modify: `claudeConfig/.claude/agents/merger.md`

- [ ] **Step 1:** Inspect current frontmatter.

```bash
sed -n '1,15p' claudeConfig/.claude/agents/merger.md
```

- [ ] **Step 2:** Add `SendMessage` to `tools:` list. (Merger likely currently has `Bash, Read` only — confirm.)

- [ ] **Step 3:** Replace the prompt's workflow section with:

```markdown
## Workflow

You are a team member of `ticket-TASK-XXX`. On startup, invoke `Skill({skill: "agent-team"})` and follow the **merger protocol** in Section "Phase 2".

Key responsibilities:
- Wait for SendMessage from developer@... ("ready: ..."). Anything else → SendMessage(team-lead@..., "unexpected message: <quote>") and stop.
- Execute the merge sequence: `cd /app`, fetch, checkout/pull base, `git reset --hard HEAD`, `apply-app-variant.sh`, `git merge --no-ff <branch>`, `git worktree remove`, `git branch -d`.
- Reply: SendMessage(team-lead@..., "merged TASK-XXX, commit=<sha>") OR "merge failed: <reason>".

**CRITICAL — never `git add` / `git commit`** in the merger. Only `git merge` and `git reset --hard HEAD` on /app are permitted. See CLAUDE.md "Merger never fabricates commits".

**Do not**: spawn agents, TeamCreate, TeamDelete, edit files anywhere.
```

- [ ] **Step 4:** Verify.

```bash
grep -E "SendMessage|^## Workflow" claudeConfig/.claude/agents/merger.md | head
```

### Task 2.5: chat-orchestrator.md

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md`

- [ ] **Step 1:** Inspect the current orchestration section.

```bash
sed -n '1,30p' claudeConfig/.claude/agents/chat-orchestrator.md
grep -n '^##\|TeamCreate\|TeamDelete\|spawn' claudeConfig/.claude/agents/chat-orchestrator.md | head -30
```

- [ ] **Step 2:** Confirm the frontmatter `tools:` already includes `Agent`, `TeamCreate`, `TeamDelete`, `Skill`, `Read`, `Bash`. Add `SendMessage` if not present (it should be — orchestrator already had it from current usage, but verify).

- [ ] **Step 3:** Replace the orchestration body (the "## Workflow" / "## Direct mode" / "## Complex mode" sections — whatever they are called today) with a single section pointing to the skill:

```markdown
## Workflow

For any code-change request, you are the **team-lead**. Follow the **agent-team v2** skill:

1. Classify: simple (one-shot UI tweak, single file, no test impact) vs complex (multi-file, data flow, anything ambiguous → default complex).
2. Invoke `Skill({skill: "agent-team"})` and follow Phase 1 (team setup): TeamCreate + spawn 2 agents (simple) or 4 agents (complex), with name@team IDs.
3. Send ONE go SendMessage to the developer.
4. **Stay passive.** Do NOT poll, spawn more agents mid-pipeline, or relay messages between teammates. The team auto-runs.
5. When the merger SendMessages back ("merged X" or "merge failed: ..."), do Phase 3 (cleanup): filesystem rm of subagent transcripts + TeamDelete + reply to user.

For non-code requests (general chat, status questions), reply directly without spawning a team.

For abort/timeout situations, see "Failure paths" in the skill.
```

- [ ] **Step 4:** Verify the skill reference is in place.

```bash
grep -E "agent-team v2|Phase 1.*team setup|Skill.*agent-team" claudeConfig/.claude/agents/chat-orchestrator.md
```

### Task 2.6: Commit Phase 2

- [ ] **Step 1:** Stage and commit all 5 agent files.

```bash
git add claudeConfig/.claude/agents/developer.md \
        claudeConfig/.claude/agents/quality-reviewer.md \
        claudeConfig/.claude/agents/test-validator.md \
        claudeConfig/.claude/agents/merger.md \
        claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "$(cat <<'EOF'
feat(agents): add SendMessage tool, align prompts with agent-team skill v2

All ticket-team agents (developer, quality-reviewer, test-validator,
merger) gain SendMessage in their tools and a short Workflow section
that points to the agent-team skill rather than duplicating the protocol.

test-validator's model upgraded haiku→sonnet because it now judges
test PERTINENCE (semantic), not just presence/reachability.

chat-orchestrator's prompt rewritten to spawn-and-forget the team and
delegate the orchestration logic to the skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Hook PreToolUse / SendMessage

Replace the 5 `SubagentStop / matcher: developer` hooks with a single `PreToolUse / matcher: SendMessage` hook that gates the dev's fix→review handoff.

### Task 3.1: Write tests for `validate-before-review.sh`

**Files:**
- Create: `claudeConfig/.claude/hooks/test/validate-before-review.test.sh`

- [ ] **Step 1:** Create the test directory and file.

```bash
mkdir -p claudeConfig/.claude/hooks/test
cat > claudeConfig/.claude/hooks/test/validate-before-review.test.sh <<'TEST_EOF'
#!/bin/bash
# Tests for validate-before-review.sh
# Run with: bash claudeConfig/.claude/hooks/test/validate-before-review.test.sh

set -u
SCRIPT_UNDER_TEST="$(dirname "$0")/../validate-before-review.sh"
PASS=0
FAIL=0

assert_exit() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1))
    echo "PASS — $desc (exit=$actual)"
  else
    FAIL=$((FAIL+1))
    echo "FAIL — $desc (expected=$expected actual=$actual)"
  fi
}

# Test 1: skip when SendMessage target is the team-lead (not a reviewer/merger)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"team-lead@ticket-TASK-001","message":"stuck"}}'
echo "$INPUT" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip when to=team-lead" 0 $?

# Test 2: skip when SendMessage target is another developer (cross-team — shouldn't happen but be defensive)
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"developer@other-team","message":"hi"}}'
echo "$INPUT" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip when to=developer@other" 0 $?

# Test 3: validate when target is quality-reviewer (should call validation chain — we mock all-pass via env)
# We can't easily mock real npm runs in a unit test, so we run with VALIDATE_DRY_RUN=1
# which the script must honor (skip actual command execution but log the would-be calls).
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer@ticket-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=quality-reviewer (dry-run all pass)" 0 $?

# Test 4: validate when target is test-validator
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"test-validator@ticket-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=test-validator (dry-run all pass)" 0 $?

# Test 5: validate when target is merger
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"merger@ticket-TASK-001","message":"ready"}}'
VALIDATE_DRY_RUN=1 echo "$INPUT" | VALIDATE_DRY_RUN=1 "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "validate when to=merger (dry-run all pass)" 0 $?

# Test 6: failure case — VALIDATE_DRY_RUN=fail simulates a failing sub-script
INPUT='{"tool_name":"SendMessage","tool_input":{"to":"quality-reviewer@ticket-TASK-001","message":"ready"}}'
echo "$INPUT" | VALIDATE_DRY_RUN=fail "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "block when one validator fails" 2 $?

# Test 7: malformed input — empty stdin → skip (not a SendMessage we can parse)
echo "" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip on empty stdin" 0 $?

# Test 8: malformed input — JSON without tool_input.to → skip
INPUT='{"tool_name":"SendMessage","tool_input":{}}'
echo "$INPUT" | "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
assert_exit "skip when tool_input.to is missing" 0 $?

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"
exit $FAIL
TEST_EOF
chmod +x claudeConfig/.claude/hooks/test/validate-before-review.test.sh
```

- [ ] **Step 2:** Run the tests now (they should fail because the script doesn't exist yet).

```bash
bash claudeConfig/.claude/hooks/test/validate-before-review.test.sh 2>&1 | tail -15
```

Expected: 8 FAIL lines (script not found), exit non-zero.

### Task 3.2: Implement `validate-before-review.sh`

**Files:**
- Create: `claudeConfig/.claude/hooks/validate-before-review.sh`

- [ ] **Step 1:** Write the script.

```bash
cat > claudeConfig/.claude/hooks/validate-before-review.sh <<'SCRIPT_EOF'
#!/bin/bash
# PreToolUse hook for SendMessage tool.
# When the developer is about to SendMessage a reviewer or merger,
# run the project validation chain. If any step fails, exit 2 to block
# the SendMessage; the dev sees the stderr as a tool_use_error.
#
# Behavior:
# - Reads the tool input JSON from stdin.
# - If tool_input.to does not match (quality-reviewer|test-validator|merger)@*, exit 0 (skip).
# - Otherwise runs (in order): typecheck, prettier, unit-app, unit-functions, e2e.
# - First failure → exit 2 with the failing script's stderr passed through.
#
# DRY RUN MODE: VALIDATE_DRY_RUN=1 → all sub-scripts are skipped, exit 0.
#               VALIDATE_DRY_RUN=fail → simulates a failure, exit 2.

set -u

LOG=/chat-service/logs/hooks.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

STDIN=$(cat)
if [ -z "$STDIN" ]; then
  exit 0
fi

# Parse the recipient from JSON. We use jq if available, fall back to grep.
if command -v jq >/dev/null 2>&1; then
  TO=$(echo "$STDIN" | jq -r '.tool_input.to // ""' 2>/dev/null || echo "")
else
  # Crude fallback: extract "to":"..." value
  TO=$(echo "$STDIN" | grep -oE '"to"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"to"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
fi

case "$TO" in
  quality-reviewer@*|test-validator@*|merger@*)
    : # gate enabled
    ;;
  *)
    exit 0
    ;;
esac

echo "[$(date -Iseconds)] validate-before-review START to=$TO" >> "$LOG" 2>/dev/null || true

# Dry-run hooks (test-only)
case "${VALIDATE_DRY_RUN:-}" in
  1)
    echo "[$(date -Iseconds)] validate-before-review DRY_RUN=1, skipping checks, exit 0" >> "$LOG" 2>/dev/null || true
    exit 0
    ;;
  fail)
    echo "[$(date -Iseconds)] validate-before-review DRY_RUN=fail, exit 2" >> "$LOG" 2>/dev/null || true
    echo "Validation failed (simulated)." >&2
    exit 2
    ;;
esac

HOOK_DIR="$(dirname "$0")"

# Ordered list: cheapest checks first to fail fast.
SCRIPTS=(
  typecheck-on-commit.sh
  prettier-on-stop.sh
  run-unit-tests-app.sh
  run-unit-tests-functions.sh
  run-e2e-tests.sh
)

for script in "${SCRIPTS[@]}"; do
  full="$HOOK_DIR/$script"
  if [ ! -x "$full" ]; then
    echo "[$(date -Iseconds)] validate-before-review WARN $script missing or not executable, skipping" >> "$LOG" 2>/dev/null || true
    continue
  fi
  # Pipe an empty SubagentStop-like stdin so the existing scripts don't error on cat.
  EMPTY_STDIN='{"hook_event_name":"PreToolUse_SendMessage","matcher":"SendMessage"}'
  if echo "$EMPTY_STDIN" | "$full" >/tmp/validate-stderr-$$.log 2>&1; then
    echo "[$(date -Iseconds)] validate-before-review $script OK" >> "$LOG" 2>/dev/null || true
  else
    EXIT=$?
    echo "[$(date -Iseconds)] validate-before-review $script FAILED exit=$EXIT" >> "$LOG" 2>/dev/null || true
    cat /tmp/validate-stderr-$$.log >&2
    rm -f /tmp/validate-stderr-$$.log
    exit 2
  fi
  rm -f /tmp/validate-stderr-$$.log
done

echo "[$(date -Iseconds)] validate-before-review ALL OK to=$TO" >> "$LOG" 2>/dev/null || true
exit 0
SCRIPT_EOF
chmod +x claudeConfig/.claude/hooks/validate-before-review.sh
```

- [ ] **Step 2:** Run the tests, expect all pass.

```bash
bash claudeConfig/.claude/hooks/test/validate-before-review.test.sh 2>&1 | tail -15
```

Expected: 8 PASS lines, exit 0.

- [ ] **Step 3:** If tests fail, iterate on the script. Common gotchas:
- `jq` not available on the host (fallback grep should kick in)
- Path mismatches in test mode (test runs from project root; hook resolves paths via `dirname "$0"`)

### Task 3.3: Update `settings.json` to swap hooks

**Files:**
- Modify: `claudeConfig/.claude/settings.json`

- [ ] **Step 1:** Inspect the current hooks section.

```bash
jq '.hooks' claudeConfig/.claude/settings.json
```

Note the structure: `PreToolUse` array (with Bash matcher today) and `SubagentStop` array (with 5 entries for matcher developer).

- [ ] **Step 2:** Use Edit tool to:

(a) Add a new entry in the `PreToolUse` array (after the existing Bash matcher), with this content:

```json
{
  "matcher": "SendMessage",
  "hooks": [
    {
      "type": "command",
      "command": "/home/developer/.claude/hooks/validate-before-review.sh",
      "timeout": 180,
      "statusMessage": "Validating before review/merge..."
    }
  ]
}
```

(b) Replace the entire `SubagentStop` array with `[]` (empty). The 5 existing scripts remain on disk but are no longer auto-invoked by the framework.

- [ ] **Step 3:** Verify the change with jq.

```bash
jq '.hooks.PreToolUse[] | select(.matcher == "SendMessage")' claudeConfig/.claude/settings.json
jq '.hooks.SubagentStop' claudeConfig/.claude/settings.json
```

Expected output:
```
{
  "matcher": "SendMessage",
  "hooks": [
    {
      "type": "command",
      "command": "/home/developer/.claude/hooks/validate-before-review.sh",
      "timeout": 180,
      "statusMessage": "Validating before review/merge..."
    }
  ]
}
[]
```

### Task 3.4: Commit Phase 3

- [ ] **Step 1:** Stage and commit.

```bash
git add claudeConfig/.claude/hooks/validate-before-review.sh \
        claudeConfig/.claude/hooks/test/validate-before-review.test.sh \
        claudeConfig/.claude/settings.json
git commit -m "$(cat <<'EOF'
feat(hooks): replace 5 SubagentStop hooks with one PreToolUse SendMessage gate

The new validate-before-review.sh runs the existing validation chain
(typecheck + prettier + unit-app + unit-functions + e2e) when the
developer is about to SendMessage a reviewer or merger. If any step
fails, the SendMessage is blocked (exit 2) and the dev sees the stderr
as a tool_use_error.

This replaces the SubagentStop hooks that were firing on every dev
pause regardless of intent, often redundantly. The PreToolUse hook
fires exactly once per fix-cycle, when it matters.

Tests: bash unit tests in hooks/test/ cover skip/validate/fail cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — chat-service updates

### Task 4.1: Test for `CLAUDE_SESSION_ID` injection

**Files:**
- Create: `chat-service/test/server-spawn.test.js`

- [ ] **Step 1:** Inspect existing chat-service test infrastructure.

```bash
ls chat-service/test/
head -30 chat-service/test/stats.test.js 2>&1
```

- [ ] **Step 2:** Write a test that verifies the spawn function passes `CLAUDE_SESSION_ID` in env.

```bash
cat > chat-service/test/server-spawn.test.js <<'TEST_EOF'
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSpawnEnv } from '../lib/spawn-env.js';

test('buildSpawnEnv injects CLAUDE_SESSION_ID', () => {
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/x' };
  const result = buildSpawnEnv(baseEnv, 'eefd5f20-305b-4768-b47f-d9ff718c690a');
  assert.equal(result.CLAUDE_SESSION_ID, 'eefd5f20-305b-4768-b47f-d9ff718c690a');
  // Existing env preserved
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/home/x');
});

test('buildSpawnEnv with empty session id leaves var unset', () => {
  const baseEnv = { PATH: '/usr/bin' };
  const result = buildSpawnEnv(baseEnv, '');
  assert.equal('CLAUDE_SESSION_ID' in result, false, 'should not set empty session id');
});

test('buildSpawnEnv with null session id leaves var unset', () => {
  const baseEnv = { PATH: '/usr/bin' };
  const result = buildSpawnEnv(baseEnv, null);
  assert.equal('CLAUDE_SESSION_ID' in result, false);
});
TEST_EOF
```

- [ ] **Step 3:** Run the test to verify it fails (helper module doesn't exist yet).

```bash
cd chat-service && node --test test/server-spawn.test.js 2>&1 | tail -10
```

Expected: 3 fails (`Cannot find package` or import error).

### Task 4.2: Implement `buildSpawnEnv` and integrate in `server.js`

**Files:**
- Create: `chat-service/lib/spawn-env.js`
- Modify: `chat-service/server.js` (the spawn site)

- [ ] **Step 1:** Create the helper module.

```bash
cat > chat-service/lib/spawn-env.js <<'JS_EOF'
// Builds the env object for the `claude -p` spawn.
// Injects CLAUDE_SESSION_ID so the lead's Bash hooks can reference the
// claude session id when doing transcript filesystem cleanup.

export function buildSpawnEnv(baseEnv, claudeSessionId) {
  const env = { ...baseEnv };
  if (claudeSessionId) {
    env.CLAUDE_SESSION_ID = claudeSessionId;
  }
  return env;
}
JS_EOF
```

- [ ] **Step 2:** Run the test, expect pass.

```bash
cd chat-service && node --test test/server-spawn.test.js 2>&1 | tail -10
```

Expected: 3 passes.

- [ ] **Step 3:** Locate the spawn site in `server.js` and integrate.

```bash
grep -n "spawn\|claude.*-p\|env:" chat-service/server.js | head -20
```

- [ ] **Step 4:** Use Edit tool. Add at the top of `server.js`:

```js
import { buildSpawnEnv } from './lib/spawn-env.js';
```

(or use `require` if the file uses CommonJS — confirm convention from existing imports).

Find the spawn call (likely `child_process.spawn('claude', ['-p', ...])` with an `env:` option) and wrap the env construction:

```js
// Before (illustrative):
const proc = spawn('claude', args, { env: process.env, ... });

// After:
const proc = spawn('claude', args, {
  env: buildSpawnEnv(process.env, runtime.claudeSessionId),
  ...
});
```

- [ ] **Step 5:** Run the full chat-service test suite to ensure nothing else broke.

```bash
cd chat-service && npm test 2>&1 | tail -20
```

Expected: all tests pass.

### Task 4.3: Commit Phase 4

- [ ] **Step 1:** Stage and commit.

```bash
git add chat-service/lib/spawn-env.js chat-service/test/server-spawn.test.js chat-service/server.js
git commit -m "$(cat <<'EOF'
feat(chat-service): inject CLAUDE_SESSION_ID into the claude -p spawn env

The lead (chat-orchestrator) needs $CLAUDE_SESSION_ID accessible at
runtime for the Phase 3 cleanup (rm of subagent transcripts in
/home/developer/.claude/projects/-app/<sid>/subagents/).

Phase 0 Q3 verified the var is not set natively by Claude Code 2.1.118
in the spawned process env, so the chat-service injects it.

New helper lib/spawn-env.js with unit tests. server.js wraps the
existing spawn() env: option through it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Stats panel adaptation [OPTIONAL — defer if time-boxed]

This phase fixes the "agent unknown" bug and restructures the phase model in `stats.js` to handle multi-activation per agent. **Spec marks this as deferable** — Phase 6 e2e tests and Phase 7 doc update do not depend on it.

### Task 5.1: Add fixture for SendMessage-resume

**Files:**
- Create: `chat-service/test/fixtures/sendmessage-resume.jsonl`

- [ ] **Step 1:** Build a minimal fixture mimicking the de4b5b2b structure.

```bash
mkdir -p chat-service/test/fixtures
cp /home/jerome/Work/crm-builder/sessions/de4b5b2b-2fec-47f6-86aa-cb16ee6238a1/log.jsonl /tmp/de4b5b2b-full.jsonl
# Extract just the relevant slice: lead's Agent spawn + dev task_started + SendMessage resume + dev second task_started
head -200 /tmp/de4b5b2b-full.jsonl > chat-service/test/fixtures/sendmessage-resume.jsonl
wc -l chat-service/test/fixtures/sendmessage-resume.jsonl
```

(Adjust the slice manually if needed to keep only the relevant turns. The fixture should contain: 1 Agent spawn for developer + 1 task_started + 1 task_notification + 1 SendMessage tool_use + 1 second task_started for same task_id with different tool_use_id.)

### Task 5.2: Update `stats.js` to index by `task_id`

**Files:**
- Modify: `chat-service/lib/stats.js`

- [ ] **Step 1:** Open `stats.js` around lines 115-150.

```bash
sed -n '115,155p' chat-service/lib/stats.js
```

- [ ] **Step 2:** Refactor `extractPhases` to:

(a) Build `agentTypeByTaskId` map (instead of `agentTypeByToolId`) by walking events: when a `task_started` follows an `Agent` tool_use with the same `tool_use_id`, record `task_id → subagent_type`.

(b) When seeing a `task_started` for an already-known `task_id` (resume case), DO NOT create a new phase — instead, add an "activation" sub-record to the existing phase's `activations` array.

(c) The final output is one phase per unique `task_id`.

Specific edit (replace the `agentTypeByToolId` lookup at line 133):

```js
// Before:
agentType: agentTypeByToolId.get(ev.tool_use_id) ?? 'unknown',

// After:
agentType: agentTypeByTaskId.get(ev.task_id) ?? subagentTypeFromAgentToolUse(ev.tool_use_id, agentToolUses) ?? 'unknown',
```

Where `agentToolUses` is a Map (`tool_use_id → subagent_type`) built in a single first-pass scan.

- [ ] **Step 3:** Add a helper `subagentTypeFromAgentToolUse(toolUseId, map)` that lookups in the Agent tool-use map. Used as a fallback for the very first activation when `agentTypeByTaskId` is still being populated.

- [ ] **Step 4:** Update the test file to exercise the SendMessage-resume fixture.

```bash
cat >> chat-service/test/stats.test.js <<'TEST_EOF'

test('phases group multiple task_started for the same task_id (SendMessage resume)', async () => {
  const result = await aggregateSession({
    sessionLogPath: 'test/fixtures/sendmessage-resume.jsonl',
    hooksLogPath: '/dev/null',
    sessionId: 'fixture-resume',
  });
  // Expect one developer phase, NOT two; agent type is 'developer' not 'unknown'.
  const devPhases = result.agents.filter(p => p.agentType === 'developer');
  assert.equal(devPhases.length, 1, 'should have a single developer phase');
  const unknown = result.agents.filter(p => p.agentType === 'unknown');
  assert.equal(unknown.length, 0, 'no unknown phases');
  // The phase should reflect at least 2 activations.
  assert.ok((devPhases[0].activations || []).length >= 2, 'developer should have ≥2 activations');
});
TEST_EOF
```

- [ ] **Step 5:** Run tests, iterate until pass.

```bash
cd chat-service && node --test test/stats.test.js 2>&1 | tail -20
```

### Task 5.3: Frontend bandes d'activation [STRETCH — can defer]

**Files:**
- Modify: `chat-service/public/chat.js` (panel render code) and `chat-service/public/chat.css`

- [ ] **Step 1:** In the stats panel render code, when iterating phases, render each phase's `activations` as horizontal bands within a per-agent row, with timestamps.

- [ ] **Step 2:** Add CSS for the band:

```css
.stats-activation-band {
  display: inline-block;
  height: 10px;
  background: var(--accent);
  margin: 0 1px;
  border-radius: 2px;
}
```

- [ ] **Step 3:** Smoke-test by opening a session with multiple activations in the chat UI.

(This step is exploratory; don't block the phase on visual perfection.)

### Task 5.4: Commit Phase 5

- [ ] **Step 1:** Stage and commit.

```bash
git add chat-service/lib/stats.js chat-service/test/stats.test.js chat-service/test/fixtures/sendmessage-resume.jsonl chat-service/public/chat.js chat-service/public/chat.css 2>&1 || true
git commit -m "$(cat <<'EOF'
fix(stats): index agent phases by task_id, group SendMessage-resume activations

The previous implementation indexed by tool_use_id, which broke when an
agent was resumed via SendMessage (each resume gets a new tool_use_id
but keeps the same task_id). This caused the panel to show duplicate
phases labelled 'unknown'.

Fix:
- agentTypeByTaskId map populated in a first-pass scan over Agent tool_uses
- Subsequent task_started events for the same task_id append to existing
  phase's activations[] instead of creating a new phase
- Fallback chain ensures 'unknown' is used only when truly unidentifiable

Test: new fixture chat-service/test/fixtures/sendmessage-resume.jsonl
based on real de4b5b2b session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — End-to-end tests

Real ticket runs against the demo container with the new system. Capture full session logs and analyze.

### Task 6.1: End-to-end simple-mode run

**Files:**
- Create: `docs/superpowers/runs/2026-04-27-agent-teams-e2e-simple.md`

- [ ] **Step 1:** Ensure the demo container is up with the new code mounted (claudeConfig is bind-mounted, chat-service is bind-mounted in dev).

```bash
docker compose --profile demo up -d 2>&1 | tail -3
sleep 8
curl -s -o /dev/null -w "8080 -> HTTP %{http_code}\n" http://localhost:8080/
```

Expected: HTTP 200.

- [ ] **Step 2:** Open the chat UI and send a simple-mode prompt (one-shot UI tweak):

```
Renomme le label "Hot Contacts" du dashboard en "VIP Contacts"
```

- [ ] **Step 3:** Wait for the "TASK-... done" message. Note the session id from `sessions/`.

```bash
ls -t sessions/ | head -1
SID=$(ls -t sessions/ | head -1)
echo "Session: $SID"
```

- [ ] **Step 4:** Verify post-run state:

```bash
# Subagent transcripts CLEANED?
docker exec atomic-crm-demo bash -c "ls /home/developer/.claude/projects/-app/*/subagents/ 2>/dev/null | wc -l"
# Team config CLEANED?
docker exec atomic-crm-demo bash -c "ls /home/developer/.claude/teams/ 2>/dev/null | grep quick- || echo 'clean'"
# Worktree CLEANED?
docker exec atomic-crm-demo bash -c "ls /worktrees/ 2>/dev/null"
# Git history shows merge commit?
docker exec atomic-crm-demo bash -c "cd /app && git log --oneline -5"
```

Expected: subagents dir empty (or zero `*@quick-*` entries), no `quick-*` team dir, worktree gone, merge commit at HEAD.

- [ ] **Step 5:** Document the run.

```bash
cat > docs/superpowers/runs/2026-04-27-agent-teams-e2e-simple.md <<EOF
# Agent-teams E2E — simple mode

**Date:** 2026-04-27
**Session:** $SID
**Prompt:** "Renomme le label \"Hot Contacts\" du dashboard en \"VIP Contacts\""

## Outcome

(success / failure / partial)

## Timeline

(extracted from sessions/$SID/log.jsonl — paste key events)

## Cleanup verification

- Subagent transcripts: clean / leaked
- Team config: clean / leaked
- Worktree: clean / leaked
- Merge commit at HEAD: yes / no

## Observations

(notes on latency, hooks, retry counts, anything unexpected)
EOF
```

- [ ] **Step 6:** Fill the placeholders manually based on the actual run.

### Task 6.2: End-to-end complex-mode run with BLOCKED→fix cycle

**Files:**
- Create: `docs/superpowers/runs/2026-04-27-agent-teams-e2e-complex.md`

- [ ] **Step 1:** Send a complex-mode prompt that's likely to trigger at least one BLOCKED→fix cycle (a feature with explicit test requirements):

```
Ajoute un champ "tags" sur les contacts (tableau de strings, max 5 tags) avec un input multi-tag dans la fiche contact, un filtre "filtrer par tag" dans la liste, et des tests unitaires couvrant l'ajout/suppression de tags + e2e qui vérifie le filtre.
```

- [ ] **Step 2:** Wait for completion. Capture the session id.

- [ ] **Step 3:** Verify the BLOCKED→fix cycle happened by inspecting the log:

```bash
SID=$(ls -t sessions/ | head -1)
jq -c 'select(.event.message.content[]?.input.message? | tostring | test("BLOCKED";"i"))' sessions/$SID/log.jsonl | wc -l
```

Expected: ≥ 1 BLOCKED message in the SendMessage events.

- [ ] **Step 4:** Verify cleanup as in Task 6.1 Step 4.

- [ ] **Step 5:** Document the run with the same format. Include extra sections:

```markdown
## Fix-cycle observations

- Reviewers initial verdicts: (quality: APPROVED/BLOCKED, test-validator: APPROVED/BLOCKED)
- Number of fix-cycles: N
- R1 verified: did dev re-notify ALL reviewers on each fix? (yes/no)

## Mode 2 reflection

- Reflection file written: yes/no
- Path: docs/reflections/TASK-XXX-reflection.md
- Committed in worktree before merger: yes/no

## Hook activations

- PreToolUse SendMessage hook fired: count
- Validation failures: count + reasons
```

### Task 6.3: Commit Phase 6 reports

- [ ] **Step 1:** Stage and commit.

```bash
git add docs/superpowers/runs/2026-04-27-agent-teams-e2e-simple.md \
        docs/superpowers/runs/2026-04-27-agent-teams-e2e-complex.md
git commit -m "$(cat <<'EOF'
docs(runs): agent-teams end-to-end test reports

Two test runs against the redesigned agent-teams flow:
- Simple mode: one-shot UI label change
- Complex mode: tags feature with at least one BLOCKED→fix cycle

Verifies cleanup (transcripts, team config, worktree), R1 (dev re-notifies
all reviewers on each fix), Mode 2 reflection, hook gating.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Doc and merge

### Task 7.1: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Find the "Agent team" section.

```bash
grep -n "## Agent team\|Hooks gate the handoff\|9 agents" CLAUDE.md | head
```

- [ ] **Step 2:** Replace the "Agent team" and "Hooks gate the handoff" sections with the new architecture description.

Use Edit tool. The new content:

```markdown
## Agent team

9 agents in [claudeConfig/.claude/agents/](claudeConfig/.claude/agents/). Each one: frontmatter (name, description, model, tools, skills) + prose. Models deliberately scoped:

| Agent | Model | Role |
|---|---|---|
| chat-orchestrator | sonnet | User-facing. Team-lead role: classify, spawn 4 agents upfront with name@team IDs, send GO to dev, then passive until merger pings back. Phase 3 cleanup (rm subagent transcripts + TeamDelete). |
| planner | sonnet | Decomposes need → atomic tickets (JSON) with waves + file-path hints. (NOT a team member; orchestrator-spawned task subagent.) |
| architect | opus | Spec gatekeeper. (NOT a team member.) |
| developer | opus | Team member. Implements, P3 counter for approvals, R1 re-notification, Mode 2 reflection (complex mode), pushes to merger. |
| quality-reviewer | sonnet | Team member. Direct dialogue with developer; APPROVED/BLOCKED verdicts. |
| test-validator | **sonnet** | Team member. Test PRESENCE + PERTINENCE judgment (semantic, not just structural). |
| merger | haiku | Team member. `git merge --no-ff`, cleanup worktree, ping team-lead. **Never `git add` / `git commit`** — only `git merge` and `git reset --hard HEAD` on `/app`. |
| devops | sonnet | One-time bootstrap. (NOT a team member.) |
| project-manager | sonnet | Domain interview. (NOT a team member.) |

**Team members get `SendMessage` in their tools** and predictable IDs (`developer@ticket-TASK-XXX`, etc.). Reviewers fix-cycle directly with the developer; the orchestrator does not broker messages.

The full lifecycle is encoded in the [agent-team v2](claudeConfig/.claude/skills/agent-team/) skill (single source of truth for dispatch + protocol per role).

### Hooks gate the developer's review handoff

[claudeConfig/.claude/settings.json](claudeConfig/.claude/settings.json) wires:
- `PreToolUse / Bash` → silent-mode-check, circuit-breaker, block-bash-file-write, block-bash-validation. (unchanged)
- `PreToolUse / SendMessage` → `validate-before-review.sh`, runs typecheck + prettier + unit-app + unit-functions + e2e when the dev is about to SendMessage a reviewer or merger. Failure blocks the SendMessage; the dev sees the stderr as a tool_use_error and fixes.

Reviewers must never re-run validation — they check *meaning*; the PreToolUse hook guarantees *correctness*.
```

- [ ] **Step 3:** Verify the rendered table.

```bash
grep -A 15 "## Agent team" CLAUDE.md | head -20
```

### Task 7.2: Push branch and open PR

- [ ] **Step 1:** Run the full test suites one more time.

```bash
cd chat-service && npm test 2>&1 | tail -5
bash claudeConfig/.claude/hooks/test/validate-before-review.test.sh 2>&1 | tail -5
```

Expected: all green.

- [ ] **Step 2:** Commit the CLAUDE.md update and push the branch.

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(CLAUDE.md): update Agent team section for peer-to-peer flow

Reflects the redesign:
- Team members (developer, reviewers, merger) get SendMessage and name@team IDs
- chat-orchestrator is team-lead with spawn-and-forget + cleanup roles
- Hook moved from SubagentStop x5 to one PreToolUse SendMessage gate
- test-validator promoted haiku→sonnet for pertinence judgment

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin fix/agent-teams-real-communication 2>&1 | tail -5
```

- [ ] **Step 3:** Open the PR.

```bash
gh pr create --title "Refactor agent-teams for real peer-to-peer communication" --body "$(cat <<'EOF'
## Summary

- Replaces hub-and-spoke orchestration with peer-to-peer agent-team communication
- Lead spawns 4 agents upfront with `name@team` IDs, sends ONE go message, stays passive until merger pings back
- Reviewers (quality + test-validator) dialogue directly with developer for fix-cycles
- Developer counts approvals (P3), re-notifies all on each fix (R1), runs Mode 2 reflection, pushes to merger
- Lead does deterministic filesystem cleanup of subagent transcripts at end-of-team
- Single PreToolUse SendMessage hook replaces 5 SubagentStop hooks

Spec: [docs/superpowers/specs/2026-04-27-agent-teams-redesign-design.md](docs/superpowers/specs/2026-04-27-agent-teams-redesign-design.md)
Plan: [docs/superpowers/plans/2026-04-27-agent-teams-redesign.md](docs/superpowers/plans/2026-04-27-agent-teams-redesign.md)
Phase 0 validation: [docs/superpowers/runs/2026-04-27-agent-teams-validation.md](docs/superpowers/runs/2026-04-27-agent-teams-validation.md)

## Test plan

- [x] Phase 0 validation passed (Q1-Q4)
- [x] Hook unit tests (`bash claudeConfig/.claude/hooks/test/validate-before-review.test.sh`)
- [x] chat-service unit tests (`cd chat-service && npm test`)
- [x] Simple-mode E2E (one-shot UI tweak) — see runs/agent-teams-e2e-simple.md
- [x] Complex-mode E2E with BLOCKED→fix cycle — see runs/agent-teams-e2e-complex.md
- [x] Cleanup verified: zero leaked subagent transcripts after run, zero leaked team configs, worktree removed

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

After all phases done, verify:

1. **Spec coverage** — every section of the spec is addressed:
   - Section 1 architecture → Phases 1-2 (skill + agents)
   - Section 2 roles/tools → Phase 2
   - Section 3 flow → Skill (Phase 1) + agent prompts (Phase 2)
   - Section 4.1 wait mechanism → Phase 0 Q1
   - Section 4.2 cleanup → Phase 1 Task 1.4 + Phase 4 (CLAUDE_SESSION_ID)
   - Section 4.3 failure paths → Phase 1 Task 1.5
   - Section 4.4 hooks → Phase 3
   - Section 4.5 model upgrade → Phase 2 Task 2.3
   - Section 5 stats panel → Phase 5 (optional)
   - Section 6.2 open questions → Phase 0
   - Section 6.3 migration plan → this entire plan

2. **Placeholder scan** — no "TBD", "TODO", or "etc." standing in for real content.

3. **Type/name consistency** — `name@team` format used consistently; `validate-before-review.sh` referenced with the same path everywhere; `CLAUDE_SESSION_ID` capitalized consistently.

If gaps found, fix inline.
