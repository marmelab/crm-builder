#!/usr/bin/env bash
# Probe suite for agent-team v2 + teamdelete-gate hook validation.
#
# Runs isolated `claude -p` invocations from the devcontainer, no docker,
# no chat-service, no worktree. Each probe targets a specific communication
# pattern from the skill's Phase 3 protocol.
#
# Usage:
#   scripts/probe-suite.sh           # run all probes sequentially
#   scripts/probe-suite.sh P1 P2     # run a subset
#
# Outputs: /tmp/probe-suite/<UTC-stamp>/<Pn>.{jsonl,err} + summary.txt

set -u

REPO=/workspaces/crm-builder
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RESULTS=/tmp/probe-suite/$STAMP
mkdir -p "$RESULTS"

# ----------------------------------------------------------------------------
# Shared TMPHOME with claudeConfig synced and hook paths rewritten.
# ----------------------------------------------------------------------------
TMPHOME=$(mktemp -d -t probe-suite-home-XXXXXX)
mkdir -p "$TMPHOME/.claude"
cp -r "$REPO/claudeConfig/.claude/"* "$TMPHOME/.claude/"
cp "$HOME/.claude/.credentials.json" "$TMPHOME/.claude/.credentials.json" 2>/dev/null || true
chmod +x "$TMPHOME"/.claude/hooks/*.sh 2>/dev/null || true
node -e "
  const fs = require('fs');
  const p = '$TMPHOME/.claude/settings.json';
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/\/home\/developer\/\.claude\/hooks\//g, '$TMPHOME/.claude/hooks/');
  fs.writeFileSync(p, s);
"

# Cache the orchestrator system prompt body (for P5/P6)
ORCH_BODY=/tmp/probe-suite-orch-body.md
node -e "
  const fs = require('fs');
  const raw = fs.readFileSync('$REPO/claudeConfig/.claude/agents/chat-orchestrator.md', 'utf8');
  fs.writeFileSync('$ORCH_BODY', raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim());
"

echo "Results dir: $RESULTS"
echo "TMPHOME:     $TMPHOME"
echo

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
clean_teams() {
  rm -rf "$TMPHOME/.claude/teams" 2>/dev/null || true
}

# Run a probe. $1=name, $2=model, $3=user prompt, $4=use_orchestrator (0|1)
run_probe() {
  local name="$1" model="$2" user_prompt="$3" use_orch="${4:-0}"
  local prompt="$user_prompt"
  if [ "$use_orch" = "1" ]; then
    local orch session_dir
    orch=$(cat "$ORCH_BODY")
    session_dir=$(mktemp -d -t probe-session-XXXXXX)
    prompt=$(node -e "
      const fs = require('fs');
      const orch = fs.readFileSync('$ORCH_BODY', 'utf8');
      const env = '<mode>demo</mode>\n<session_dir>$session_dir</session_dir>';
      const userMsg = process.argv[1];
      process.stdout.write(\`<instructions>\n\${orch}\n</instructions>\n\n\${env}\n\n\${userMsg}\`);
    " "$user_prompt")
  fi

  echo "▶ $name (model=$model, orchestrator=$use_orch)"
  local start
  start=$(date +%s)
  HOME="$TMPHOME" timeout 360 claude -p \
    --output-format stream-json --verbose \
    --dangerously-skip-permissions \
    --model "$model" \
    "$prompt" \
    > "$RESULTS/$name.jsonl" 2> "$RESULTS/$name.err"
  local rc=$?
  local elapsed=$(( $(date +%s) - start ))
  local lines
  lines=$(wc -l < "$RESULTS/$name.jsonl")
  echo "  exit=$rc, ${elapsed}s, ${lines} jsonl lines"
}

# Extract a one-line summary of a probe
summarize() {
  local name="$1"
  if [ ! -s "$RESULTS/$name.jsonl" ]; then
    echo "$name: (no output)"
    return
  fi
  node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$RESULTS/$name.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    let tc=0, td=0, tdFail=0, sm=0, sa=0, hookBlocks=0, results=0, cost=0;
    for (const l of lines) {
      if (l.type === 'result') { results++; cost = Math.max(cost, l.total_cost_usd || 0); }
      if (l.type === 'assistant') {
        for (const b of l.message.content) {
          if (b.type !== 'tool_use') continue;
          if (b.name === 'TeamCreate') tc++;
          if (b.name === 'TeamDelete') td++;
          if (b.name === 'SendMessage') sm++;
          if (b.name === 'Agent') sa++;
        }
      }
      if (l.type === 'user' && Array.isArray(l.message?.content)) {
        for (const b of l.message.content) {
          if (b.type !== 'tool_result') continue;
          const cont = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          if (cont.includes('TeamDelete blocked')) hookBlocks++;
          if (cont.includes('Cannot cleanup team with')) tdFail++;
        }
      }
    }
    console.log(\`$name: TC=\${tc} TD=\${td} TDfail=\${tdFail} SM=\${sm} Agent=\${sa} hookBlocks=\${hookBlocks} resultEvents=\${results} cost=\$\${cost.toFixed(3)}\`);
  "
}

# ----------------------------------------------------------------------------
# Probe definitions
# ----------------------------------------------------------------------------

probe_P1() {
  clean_teams
  run_probe "P1" "claude-sonnet-4-6" \
    'Create team "p1" with TeamCreate. Spawn one teammate "helper" (Agent: subagent_type=general-purpose, name=helper, team_name=p1, model=haiku, prompt="When you receive a message, reply by sending a SendMessage to team-lead with content PONG. Then go idle."). SendMessage to helper: "ping". Wait for the reply by ending your turn (yield). On the next turn after seeing PONG, perform graceful teardown: SendMessage shutdown_request to helper, yield the turn, then on the next turn call TeamDelete and report success.' \
    0
}

probe_P2() {
  clean_teams
  # Force the bug pattern: TeamDelete chained right after shutdown_request, no yield.
  # Hook MUST fire and lead MUST recover.
  run_probe "P2" "claude-sonnet-4-6" \
    'Create team "p2" with TeamCreate. Spawn one teammate "alpha" (Agent: subagent_type=general-purpose, name=alpha, team_name=p2, model=haiku, prompt="reply with PONG via SendMessage to team-lead, then idle"). SendMessage to alpha: "ping". Then IMMEDIATELY in the same turn, send shutdown_request to alpha and call TeamDelete back-to-back. Do not yield between them. Observe what the system tells you, then recover correctly.' \
    0
}

probe_P3() {
  clean_teams
  run_probe "P3" "claude-sonnet-4-6" \
    'Create team "p3" with TeamCreate. Spawn TWO teammates in ONE assistant message: "alpha" and "beta" (both Agent: subagent_type=general-purpose, team_name=p3, model=haiku, prompt="reply with your name to any SendMessage you receive, then idle"). SendMessage "ping" to both alpha and beta in ONE assistant message. Yield. After receiving both replies, perform graceful teardown: send shutdown_request to BOTH in ONE message, yield, verify both shutdown_approved arrive, then TeamDelete. Report success.' \
    0
}

probe_P4() {
  clean_teams
  run_probe "P4" "claude-sonnet-4-6" \
    'Create TWO teams in ONE assistant message: TeamCreate("p4a") and TeamCreate("p4b"). For each team, spawn one teammate ("alpha@p4a" and "beta@p4b") with Agent (model=haiku, prompt="reply with your name to any SendMessage to team-lead, then idle") — all in the SAME assistant message as the TeamCreates. SendMessage "ping" to both teammates in one message. Yield. After both reply, tear down each team SEPARATELY: shutdown_request to alpha@p4a, yield, verify, TeamDelete({team_name:"p4a"}). Then same for p4b. Report success per team.' \
    0
}

probe_P5() {
  clean_teams
  run_probe "P5" "claude-sonnet-4-6" \
    'Validate the agent-team teardown protocol with a small communication probe (no actual ticket implementation). Create a team named "p5" with two helpers: "checker" (haiku, prompt: "reply OK via SendMessage to team-lead when pinged, then idle") and "reporter" (haiku, prompt: "reply with the word REPORT via SendMessage to team-lead when pinged, then idle"). Send "ping" to both. After receiving both replies, perform Phase 3 graceful shutdown EXACTLY as the agent-team skill describes (3a SendMessage shutdown_request to all in one message, 3b yield, 3c verify shutdown_approved on next turn, 3d TeamDelete, 3e Bash rm). Report success at the end.' \
    1
}

probe_P6() {
  clean_teams
  run_probe "P6" "claude-sonnet-4-6" \
    'Validate parallel team teardown. Create TWO teams in ONE message: "p6a" and "p6b". For each team, spawn TWO helpers with Agent (haiku, prompt: "reply with the word READY via SendMessage to team-lead when pinged, then idle"): "alpha"+"beta" in p6a, "gamma"+"delta" in p6b. All four spawns in the same assistant message as the TeamCreates. SendMessage "ping" to all four in one message. Yield. After all four reply, perform Phase 3 teardown SEPARATELY for each team (per skill rule "Call Steps 3a + 3b once per ticket-team — do not batch across teams"). Report success per team.' \
    1
}

# P7 — Option C validation: single project team, multiple "ticket pairs" with
# deterministic naming and counterpart-aware prompts. Verifies that:
#  - 4 agents can be spawned into one team in a single message
#  - SendMessage between counterparts (developer-A ↔ reviewer-A) works without
#    cross-talk to the other pair
#  - Phase 3 teardown of all 4 in one batch works
probe_P8() {
  clean_teams
  # Fake 2-ticket wave under v3.1 single-team + single-merger layout. 7 haiku agents.
  # Each agent's prompt makes them go through the textual handshake of their
  # role (no real file edits, no real git). Validates:
  #  - 7-agent dispatch in ONE message (3 per-ticket + 1 shared merger)
  #  - cross-pair isolation between TASK-001 and TASK-002
  #  - the shared `merger` correctly handles 2 successive "ready" messages
  #    from different developers and reports back per-ticket
  #  - validate-before-review matcher fires on quality-reviewer-* and bare `merger`
  #    (we set VALIDATE_DRY_RUN=1 so the hook returns 0 instead of running npm)
  #  - 7-member Phase 3 teardown
  VALIDATE_DRY_RUN=1 run_probe "P8" "claude-sonnet-4-6" \
'You are simulating a 2-ticket wave under the agent-team v3.1 single-team + single-merger layout. Do NOT edit any files — every step is a textual handshake to validate the routing and teardown.

Steps:

1. TeamCreate({team_name: "tickets", description: "fake wave: TASK-001 + TASK-002"})

2. In ONE assistant message, dispatch all 7 members via the Agent tool (subagent_type=general-purpose, model=haiku, run_in_background=true, team_name="tickets"). Use these EXACT names and prompts:

   Per-ticket members for TASK-001:
   - name="developer-TASK-001", prompt="ROLE: developer for TASK-001. COUNTERPARTS: reviewers=[quality-reviewer-TASK-001, test-validator-TASK-001], merger=merger (bare, shared singleton). WORKFLOW: when you receive a SendMessage from team-lead containing GO, do exactly this in ONE assistant message: SendMessage(to: quality-reviewer-TASK-001, content: ready please review TASK-001) and SendMessage(to: test-validator-TASK-001, content: ready please review TASK-001). Then idle. When BOTH reviewers have replied APPROVED back to you, SendMessage(to: merger, content: ready: TASK-001, branch=feature/fake-001). Then idle. Be concise, do not over-think, just execute the SendMessages exactly as instructed. Use bare names (no @-suffix)."
   - name="quality-reviewer-TASK-001", prompt="ROLE: quality-reviewer for TASK-001. COUNTERPART: developer-TASK-001. WORKFLOW: when you receive ANY SendMessage from developer-TASK-001, immediately reply with SendMessage(to: developer-TASK-001, content: APPROVED). Then idle. This is a routing test — do NOT perform any real review."
   - name="test-validator-TASK-001", prompt="ROLE: test-validator for TASK-001. COUNTERPART: developer-TASK-001. WORKFLOW: when you receive ANY SendMessage from developer-TASK-001, immediately reply with SendMessage(to: developer-TASK-001, content: APPROVED). Then idle. This is a routing test — do NOT perform any real validation."

   Same 3 per-ticket dispatches for TASK-002 (replace 001 with 002 in all names, prompts, branches).

   Shared singleton merger (one for the whole wave, bare name, no suffix):
   - name="merger", prompt="ROLE: shared merger for the wave (singleton, bare name). WAVE_TICKETS=[TASK-001, TASK-002]. WORKFLOW: you receive SendMessage from various developer-TASK-XXX. Each message starts with ready: TASK-XXX. When you receive one: parse TASK-XXX from the sender name, immediately SendMessage(to: team-lead, content: merged TASK-XXX commit=fake-sha-XXX-shared). Then idle and wait for the NEXT incoming message — do NOT stop after one merge, you serve the whole wave. Loop. Only stop when you receive a shutdown_request. This is a routing test — do NOT perform any real git operation."

3. In ONE assistant message after the dispatches return, send GO:
   SendMessage(to: developer-TASK-001, content: GO TASK-001)
   SendMessage(to: developer-TASK-002, content: GO TASK-002)

4. Yield. The chains run autonomously. Wait until you have received BOTH "merged TASK-XXX" reports from the shared merger (one for TASK-001, one for TASK-002).

5. Phase 3 teardown: in ONE assistant message, SendMessage shutdown_request to ALL 7 members (3 per ticket × 2 tickets + the shared merger). Then yield. On the next turn, verify all 7 shutdown_approved arrived, then call TeamDelete({}).

6. Final report: per-ticket status (TASK-001: success/fail, TASK-002: success/fail), confirm the shared merger reported BOTH tickets (not just one), and confirm zero cross-talk between TASK-001 and TASK-002 reviewer chains.' \
    0
}

probe_P7() {
  clean_teams
  run_probe "P7" "claude-sonnet-4-6" \
'Validate the Option C pattern: ONE shared team with multiple ticket-pairs and deterministic counterpart naming.

Steps:
1. TeamCreate("simC")
2. In ONE assistant message, spawn 4 agents into team "simC" via the Agent tool (subagent_type=general-purpose, model=haiku, run_in_background=true). Each agent gets a prompt that names its counterpart explicitly:

   - name="developer-A", prompt="You are developer for ticket A. Your reviewer is quality-reviewer-A. When you receive a SendMessage with content that starts with GO, send a SendMessage to quality-reviewer-A with content REVIEW_REQUEST_A. Then idle."
   - name="quality-reviewer-A", prompt="You are reviewer for ticket A. Your developer is developer-A. When you receive a SendMessage from developer-A, reply by SendMessage to developer-A with content APPROVED_A. Then idle."
   - name="developer-B", prompt="You are developer for ticket B. Your reviewer is quality-reviewer-B. When you receive a SendMessage with content that starts with GO, send a SendMessage to quality-reviewer-B with content REVIEW_REQUEST_B. Then idle."
   - name="quality-reviewer-B", prompt="You are reviewer for ticket B. Your developer is developer-B. When you receive a SendMessage from developer-B, reply by SendMessage to developer-B with content APPROVED_B. Then idle."

3. In ONE assistant message, send SendMessage to BOTH developers: GO to developer-A and GO to developer-B.

4. Yield. The communication should chain: dev-A → reviewer-A → dev-A approved; dev-B → reviewer-B → dev-B approved.

5. After both developers report APPROVED back to you (or after they all go idle once the chain completes), perform Phase 3 teardown: SendMessage shutdown_request to ALL FOUR members in ONE message, yield, verify, TeamDelete, then Bash rm.

What to verify in your final report:
- developer-A only ever talked to quality-reviewer-A (no cross-talk to ticket B agents)
- developer-B only ever talked to quality-reviewer-B
- The teardown of 4 members in one shot worked' \
    0
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
PROBES=("$@")
[ ${#PROBES[@]} -eq 0 ] && PROBES=(P1 P2 P3 P4 P5 P6 P7 P8)

for p in "${PROBES[@]}"; do
  case "$p" in
    P1) probe_P1 ;;
    P2) probe_P2 ;;
    P3) probe_P3 ;;
    P4) probe_P4 ;;
    P5) probe_P5 ;;
    P6) probe_P6 ;;
    P7) probe_P7 ;;
    P8) probe_P8 ;;
    *)  echo "unknown probe: $p" >&2 ;;
  esac
done

echo
echo "===== Summary ====="
{
  for p in "${PROBES[@]}"; do
    summarize "$p"
  done
} | tee "$RESULTS/summary.txt"

echo
echo "Logs in: $RESULTS"
