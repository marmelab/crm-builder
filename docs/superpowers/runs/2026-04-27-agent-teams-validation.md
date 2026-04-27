# Agent-teams runtime validation

**Date:** 2026-04-27
**Claude Code version:** 2.1.118
**Container used:** `atomic-crm-demo-tomorrow` (the standard `atomic-crm-demo` couldn't start from the devcontainer due to host bind-mount path mismatch; the demo-tomorrow image is functionally equivalent, frozen at the same date)
**Spec:** [docs/superpowers/specs/2026-04-27-agent-teams-redesign-design.md](../specs/2026-04-27-agent-teams-redesign-design.md)

## Q1 — How does the lead receive a SendMessage from a teammate?

**Probe:** TeamCreate(`q1probe`) + spawn `general-purpose` echoer with `name: "echoer"` + SendMessage(echoer, "Please echo.") + sleep 5 + observe.

**Run log:** `/tmp/q1probe/run-1777319365.jsonl` (in container, copied to host).

**Mechanism observed:** **W1 (designed)** — per the lead's own statement during the probe, replies from teammates are intended to surface as new conversation turns automatically (no polling, no inbox-reading required).

**However, the probe revealed two problems:**

1. **`ECHO_OK` never arrived in this probe.** The lead never saw a turn carrying the echoer's reply. Likely cause: the spawned agent has `backendType: "in-process"` (visible in the team config), and in-process subagents may not flush their outbound SendMessage back to the lead within the probe's observation window. The echoer also remained marked "active" indefinitely — never returning a `shutdown_response` after multiple `requestShutdown` attempts.
2. **`TeamDelete` is blocked while members are active.** Even after `requestShutdown`, the in-process echoer never terminated (waited 6, 10, 15 s — still active). Manual `rm -rf` of `~/.claude/teams/q1probe` was required. This contradicts the spec assumption that a quick `TeamDelete` cleans up.

**Verbatim PROBE_REPORT (final state):**

```
- echoer_agent_id: echoer@q1probe
- sendmessage_send_result: {"success":true,"message":"Message sent to echoer's inbox","routing":{"sender":"team-lead","target":"@echoer","targetColor":"blue","summary":"Please echo","content":"Please echo."}}
- mechanism_observed: W1 designed (auto-delivered turn) but in this probe ECHO_OK never surfaced
- echo_text_seen: no
- did_you_call_taskoutput: no
- did_you_read_inbox_file: no
```

**Implication for the design:**

- W1 is the **intended** mechanism but **not reliable enough on its own** in this probe. Possible explanations: (a) `general-purpose + in-process` agents don't process inbox the way `subagent_type` named agents do; (b) the probe's "synchronous-then-sleep" pattern is wrong (the lead is still inside its own turn when it sleeps, blocking inference). Real flow has the lead naturally yield the turn after `SendMessage`.
- **A deeper probe (Q1b) was run** to test hypothesis (b) with a named subagent_type. See **Q1b** below.
- **Cleanup gotcha (new):** `TeamDelete` cannot be relied on to terminate teammates — a `rm -rf ~/.claude/teams/<team>` step is mandatory in the lead's cleanup. This was already documented in spec 4.2; this probe confirms the necessity.

## Q1b — W1 deeper probe (named subagent_type, no bash-sleep)

**Probe:** TeamCreate(`q1bprobe`) + spawn `merger` (named subagent_type) with `name: "merger"` + SendMessage(merger, "echo2") + **yield turn immediately** (no bash-sleep) + observe what arrives next.

**Run log:** `/tmp/q1bprobe/run-1777321986.jsonl` (in container).

**Result:** ✅ **W1 CONFIRMED**.

Verbatim from the lead's PROBE_REPORT:

```
- merger_agent_id: merger@q1bprobe
- woke_up_via: A fresh user turn — the merger's reply arrived as
  <teammate-message teammate_id="merger" color="blue"> tags injected
  into the next incoming message. Not a tool-call result. Not a polled
  inbox. Pure push delivery into the next turn.
- echo2_text_seen: yes (twice as plain text + once in idle_notification
  summary field)
- did_you_call_taskoutput: no
- did_you_read_inbox_file: no
- elapsed_turns_between_send_and_recv: 1
```

**Confirmed mechanics:**

1. The lead must **yield its turn** after the initial `SendMessage(<member>, ...)`. No bash-sleep, no further tool call — just stop and end the turn.
2. The teammate's reply arrives in the **next user turn** as `<teammate-message teammate_id="..." color="...">...</teammate-message>` tags injected into the user-turn body.
3. Total ticket flow remains a single `claude -p` invocation, but the LLM goes through multiple turns inside it: act → yield → receive teammate message → act → yield → ...
4. **Idle notifications** can also surface as separate follow-up turns after the payload turn (no harm, just noise).
5. Slight quirk: the message text was duplicated (`ECHO2_OK` arrived twice in the same turn as plain text). Likely an in-process backend artifact. Cosmetic — doesn't break the protocol.

**Implication for the design (updated from Q1):**

- ✅ **No watchdog needed in chat-service.** Spec Section 4.1 is correct as-is for W1. The lead's prompt does not need any polling instructions.
- The lead's prompt must explicitly instruct it to **end its turn after the initial SendMessage(developer, "GO")** rather than continuing with bash sleeps or any other action. This is a one-line addition to the lead's protocol in skill v2.
- Same rule applies to dev/reviewers/merger — after each SendMessage, **yield the turn** and let teammate replies arrive naturally.

**Q1 risk downgraded to RESOLVED.**

## Q2 — Does `subagent_type + name` produce `name@team` agentId?

**Probe:** TeamCreate(`q2probe`) + `Agent({subagent_type: "developer", team_name: "q2probe", name: "developer", ...})` + capture returned agentId + Read team config.

**Run log:** `/tmp/q2probe/run-1777320739.jsonl` (in container).

**Result:** ✅ **YES** — verbatim from spawn result:

```
agent_id: developer@q2probe
name: developer
team_name: q2probe
```

Team config `members[]` confirms:

```json
{
  "agentId": "team-lead@q2probe",  "name": "team-lead",  "agentType": "team-lead", ...
}
{
  "agentId": "developer@q2probe",  "name": "developer",  "agentType": "developer",
  "color": "blue",  "tmuxPaneId": "in-process",  "backendType": "in-process",
  "model": "claude-opus-4-6", ...
}
```

**Implication for the design:** ✅ The α design (deterministic `name@team` IDs across all 4 teammates + lead) **works as intended** for named subagent_types. No fallback needed. Both the lead (`team-lead@<team>`) and named members get predictable IDs.

**Bonus observation:** All members get `backendType: "in-process"` and `tmuxPaneId: "in-process"`. There is no separate tmux pane per member in this Claude Code version — they all share the lead's process. This is relevant for Q1 (in-process inbox semantics).

## Q3 — Is `CLAUDE_SESSION_ID` accessible to the lead?

**Probe:** `claude -p "env | grep -iE \"claude|session\""`.

**Vars seen (verbatim):**

```
CLAUDECODE=1
CLAUDE_CODE_ENTRYPOINT=sdk-cli
CLAUDE_CODE_EXECPATH=/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

**`CLAUDE_SESSION_ID` available natively:** ❌ **NO**. Not exposed as env var.

**Implication for cleanup:** The chat-service **must** inject `CLAUDE_SESSION_ID=<id>` in the env passed to `spawn('claude', ...)`. Phase 4 Task 4.2 is required. The session id is already known to the chat-service ([chat-service/lib/server/claude-spawn.js:22](../../chat-service/lib/server/claude-spawn.js#L22) — `spawnClaude(userMessage, claudeSessionId, sessionDir)` receives it as parameter), so injection is a one-line addition to the env block at L39-44.

## Q4 — Why do hooks crash with `stop-hook-error`?

**Test:** Synthetic `SubagentStop` stdin piped to each of the 5 hook scripts via `bash -i`.

**Observed errors (all 5 hooks identical pattern):**

```
/home/developer/.claude/hooks/typecheck-on-commit.sh: line 8: /chat-service/logs/hooks.log: Permission denied
/home/developer/.claude/hooks/typecheck-on-commit.sh: line 21: /chat-service/logs/hooks.log: Permission denied
EXIT=0
```

Same pattern for `prettier-on-stop.sh`, `run-unit-tests-app.sh`, `run-unit-tests-functions.sh`, `run-e2e-tests.sh`.

**Root cause:** **UID/ownership mismatch on the bind-mounted `hooks.log`.**

- `/chat-service/logs/` is bind-mounted from the host (e.g. `./sessions-demo-tomorrow:/chat-service/logs` per [docker-compose.demo-tomorrow.yml](../../docker-compose.demo-tomorrow.yml)).
- Inside the container, `developer` is uid 1001 and `node` is uid 1000.
- The mount preserves host UIDs. When the host devcontainer (running as `node` uid 1000) creates `hooks.log`, it appears owned by `node:node` mode `644` inside the atomic-crm container.
- The hooks run as `developer` (uid 1001) per supervisord (`user=developer`) and per `claude` spawn — they cannot append to `node:node 644`. Each `>> $LOG` line emits "Permission denied" to stderr.
- **The hooks themselves still `exit 0`** for normal cases, but the polluted stderr can be surfaced by the Claude Code runtime as a `stop-hook-error` notification (visible in chat UI).

**Confirmation:**

```
$ docker exec atomic-crm-demo-tomorrow ls -la /chat-service/logs/hooks.log
-rw-r--r-- 1 node node 3581 Apr 27 19:38 /chat-service/logs/hooks.log
$ docker exec atomic-crm-demo-tomorrow id developer
uid=1001(developer) gid=1001(developer)
$ docker exec atomic-crm-demo-tomorrow id node
uid=1000(node) gid=1000(node)
```

**Implication for the design:**

- Trivial fix at boot: `chown developer:developer /chat-service/logs/hooks.log 2>/dev/null || true` or `chmod 666` in `entrypoint.sh` (after the `mkdir -p` of the logs dir).
- **The bug is mostly a devcontainer-only artifact** — in a normal Docker host, the host user typically matches container uid, so this mismatch wouldn't occur. But the entrypoint fix is cheap and idempotent so we should ship it.
- **No need to redesign hooks for this.** Phase 3 (PreToolUse / SendMessage) replaces 5 SubagentStop hooks with 1 PreToolUse hook anyway, but the new hook will face the same `hooks.log` issue if it tries to append from `developer`. The entrypoint chmod is the correct fix.

## Decision

### Go / no-go for the redesign

**🟢 GO**, with the following amendments to the plan:

1. **Q1 deeper probe required** before Phase 1 commits. Re-run with `subagent_type: "developer"` (named) instead of `general-purpose`, and let the lead naturally yield its turn after the SendMessage (don't bash-sleep inside the same turn). If W1 still doesn't deliver, plan a chat-service watchdog (poll `~/.claude/teams/<team>/inboxes/team-lead.json` and forward as user turn). **Add as Task 0.7** after Phase 0 commit.
2. **Phase 4 Task 4.2 (`CLAUDE_SESSION_ID` injection) is now mandatory** (was conditional). Plan untouched, just promote it from optional to required.
3. **New micro-task in Phase 3 (or entrypoint patch)**: ensure `/chat-service/logs/hooks.log` is writable by `developer` at boot. One-line fix in `entrypoint.sh`.
4. **Cleanup section in spec 4.2 must keep the explicit `rm -rf ~/.claude/teams/<team>`** step. The probe confirmed `TeamDelete` is **not sufficient** — in-process teammates do not honor `requestShutdown` reliably and `TeamDelete` blocks while they're "active". Spec already notes this, but the probe upgrades it from "extra safety" to "mandatory".
5. **Q2 ✅ confirms the α design's foundation**, no changes needed there.

### Risk register update

| Risk | New severity after probes |
|---|---|
| Lead doesn't see SendMessage replies (Q1) | **Elevated** — needs deeper probe + fallback design |
| `name@team` IDs don't work (Q2) | **Resolved** — confirmed working |
| `CLAUDE_SESSION_ID` not accessible (Q3) | **Confirmed not accessible** — Phase 4 Task 4.2 mandatory |
| Hooks crash with `stop-hook-error` (Q4) | **Root-caused** — trivial entrypoint fix |
| `TeamDelete` cleanup races (new) | **Confirmed real** — spec 4.2 `rm -rf` is mandatory, not optional |
