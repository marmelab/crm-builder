import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

function extractToolUsesFromAssistant(ev) {
  if (ev.type !== 'assistant') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_use');
}

function extractToolResultsFromUser(ev) {
  if (ev.type !== 'user') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_result');
}

function msBetween(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }

function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [[...sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const STREAM_GAP_THRESHOLD_MS = 1000;

function buildEventTsIndex(events) {
  // Only substantive stream content — assistant/user messages. task_progress fires at every
  // tool_use boundary as metadata and would falsely inflate activity counts for silent waits.
  const arr = [];
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.ts) continue;
    const t = rec.event?.type;
    if (t === 'assistant' || t === 'user') arr.push(new Date(rec.ts).getTime());
  }
  arr.sort((a, b) => a - b);
  return arr;
}

function countEventsStrictlyBetween(tsIndex, startTs, endTs) {
  const s = new Date(startTs).getTime();
  const e = new Date(endTs).getTime();
  let lo = 0, hi = tsIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsIndex[mid] <= s) lo = mid + 1; else hi = mid;
  }
  const left = lo;
  lo = 0; hi = tsIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsIndex[mid] < e) lo = mid + 1; else hi = mid;
  }
  return lo - left;
}

function computeSummary(events) {
  let opsCount = 0, tokensTotal = 0, costUsd = 0;
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    for (const _ of extractToolUsesFromAssistant(ev)) opsCount++;
    if (ev.type === 'result') {
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      // total_cost_usd is cumulative WITHIN a Claude CLI spawn — every result
      // reports the running total. With --resume, the same spawn issues many
      // result events as the orchestrator processes user turns. Summing them
      // double-counts each prior turn's cost (38 results in this session
      // produced $265 instead of the real $14.69). Take the max instead —
      // it's the comprehensive end-state for the spawn.
      costUsd = Math.max(costUsd, ev.total_cost_usd || 0);
    }
  }
  return { opsCount, tokensTotal, costUsd };
}

function colorFromName(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 65% 55%)`;
}

function extractTeams(events) {
  const agentToolIdToTeam = new Map();
  const teams = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name === 'TeamCreate' && b.input?.team_name) {
        const n = b.input.team_name;
        if (!teams.has(n)) {
          teams.set(n, {
            team_name: n,
            description: b.input.description ?? '',
            color: colorFromName(n),
            durationMs: 0, agentsCount: 0, errorsCount: 0,
          });
        }
      } else if ((b.name === 'Agent' || b.name === 'Task') && b.input?.team_name) {
        agentToolIdToTeam.set(b.id, b.input.team_name);
      }
    }
  }
  return { teams, agentToolIdToTeam };
}

function subagentTypeFromAgentToolUse(toolUseId, agentTypeByToolId) {
  return agentTypeByToolId.get(toolUseId);
}

// Both kinds of task_started events represent a real subagent we want to track:
// - 'local_agent': dispatched without team_name (planner, simple-developer, ...).
// - 'in_process_teammate': dispatched into a team (developer-TASK-XXX, reviewers,
//   merger). Without this second case, COMPLEX runs only show orchestrator+planner.
function isAgentTaskStart(ev) {
  return ev.type === 'system'
    && ev.subtype === 'task_started'
    && (ev.task_type === 'local_agent' || ev.task_type === 'in_process_teammate');
}

function extractPhases(events, agentToolIdToTeam) {
  const byTaskId = new Map();
  const agentTypeByToolId = new Map();
  const agentNameByToolId = new Map();
  const agentTypeByTaskId = new Map();
  // First pass: index Agent/Task tool_uses by their tool_use_id.
  // Also capture the dispatch `name` (e.g. "developer-TASK-001") which is needed
  // to map a phase to its per-activation subagent transcripts (N reveils via
  // SendMessage = N files, all sharing the same name in their meta.agentType).
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) {
        agentTypeByToolId.set(b.id, b.input.subagent_type);
        if (b.input.name) agentNameByToolId.set(b.id, b.input.name);
      }
    }
  }
  // Second pass: bind task_id → subagent_type via the FIRST task_started's tool_use_id.
  // Subsequent task_started for the same task_id (SendMessage-resume) get a different
  // tool_use_id but must inherit the original subagent_type.
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (isAgentTaskStart(ev)) {
      if (!agentTypeByTaskId.has(ev.task_id)) {
        const t = subagentTypeFromAgentToolUse(ev.tool_use_id, agentTypeByToolId);
        if (t) agentTypeByTaskId.set(ev.task_id, t);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (isAgentTaskStart(ev)) {
      const existing = byTaskId.get(ev.task_id);
      if (existing) {
        // Resume case — append an activation, keep the phase.
        existing.activations.push({
          startTs: rec.ts, endTs: null, durationMs: 0,
          toolUseId: ev.tool_use_id, opsCount: 0, tokensTotal: 0,
        });
      } else {
        byTaskId.set(ev.task_id, {
          phaseId: ev.task_id,
          kind: 'agent',
          agentType:
            agentTypeByTaskId.get(ev.task_id) ??
            subagentTypeFromAgentToolUse(ev.tool_use_id, agentTypeByToolId) ??
            'unknown',
          // Suffixed dispatch name (e.g. "developer-TASK-001"). Used to locate
          // per-activation subagent transcripts whose meta.agentType matches.
          // Falls back to undefined for local_agent dispatches without a name.
          agentName: agentNameByToolId.get(ev.tool_use_id),
          taskType: ev.task_type, // 'local_agent' | 'in_process_teammate' — distinguishes COMPLEX team members from planner/simple-developer
          description: ev.description || '',
          teamName: agentToolIdToTeam.get(ev.tool_use_id) ?? null,
          startTs: rec.ts,
          endTs: null, durationMs: 0, opsCount: 0, tokensTotal: 0,
          errorsCount: 0, retriesCount: 0, children: [],
          activations: [{
            startTs: rec.ts, endTs: null, durationMs: 0,
            toolUseId: ev.tool_use_id, opsCount: 0, tokensTotal: 0,
          }],
          _toolUseId: ev.tool_use_id,
        });
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && byTaskId.has(ev.task_id)) {
      const p = byTaskId.get(ev.task_id);
      const u = ev.usage || {};
      // Match the activation by tool_use_id (most reliable).
      const act =
        p.activations.find((a) => a.toolUseId === ev.tool_use_id && a.endTs === null) ??
        p.activations.find((a) => a.endTs === null) ??
        p.activations[p.activations.length - 1];
      if (act) {
        act.endTs = rec.ts;
        act.durationMs = u.duration_ms || msBetween(act.startTs, act.endTs);
        act.opsCount = u.tool_uses || 0;
        act.tokensTotal = u.total_tokens || 0;
      }
      // Phase aggregates: end at the latest notification, sum across activations.
      p.endTs = rec.ts;
      p.durationMs = p.activations.reduce((s, a) => s + (a.durationMs || 0), 0)
        || msBetween(p.startTs, p.endTs);
      p.opsCount = p.activations.reduce((s, a) => s + (a.opsCount || 0), 0);
      p.tokensTotal = p.activations.reduce((s, a) => s + (a.tokensTotal || 0), 0);
    }
  }
  return [...byTaskId.values()].sort((a, b) => a.startTs.localeCompare(b.startTs));
}

function buildOrchestratorPhase(events, agentPhases, startTs, endTs) {
  const totalMs = startTs && endTs ? msBetween(startTs, endTs) : 0;
  const intervals = agentPhases
    .filter((p) => p.startTs && p.endTs)
    .map((p) => [new Date(p.startTs).getTime(), new Date(p.endTs).getTime()]);
  const merged = mergeIntervals(intervals);
  const agentCoverageMs = merged.reduce((a, [s, e]) => a + (e - s), 0);
  let opsCount = 0;
  let tokensTotal = 0;
  const skip = new Set(['Agent', 'Task', 'TeamCreate', 'TeamDelete']);
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'assistant') {
      // Only orchestrator-emitted tool_uses — sub-agent tool_uses carry a
      // parent_tool_use_id and are already counted in their phase's opsCount
      // via the task_notification.usage.tool_uses field.
      if (ev.parent_tool_use_id != null) continue;
      for (const b of extractToolUsesFromAssistant(ev)) {
        if (skip.has(b.name)) continue;
        opsCount++;
      }
    } else if (ev.type === 'result') {
      // result.usage carries this turn's token cost (cache_read excluded —
      // it's cheap rehydration, not billed against the working set).
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.output_tokens || 0);
    }
  }
  return {
    phaseId: 'orchestrator', kind: 'orchestrator', agentType: 'orchestrator',
    description: 'Orchestrator', teamName: null,
    startTs, endTs, durationMs: Math.max(0, totalMs - agentCoverageMs),
    opsCount, tokensTotal, errorsCount: 0, retriesCount: 0, children: [],
  };
}

function buildTimeBreakdown(orchestrator, agentPhases) {
  // For sub-agents, workMs (tool durations + bounded thinking gaps) excludes
  // long idle waits on peers — the right "active" measure.
  // For the orchestrator, almost all its tool_uses are SendMessage (filtered
  // out of workMs), so workMs collapses to ~0. Its durationMs (computed as
  // session wallclock minus the coverage of its sub-agent intervals) is the
  // closer proxy for "time the orchestrator was actively driving".
  const byAgent = new Map([['orchestrator', orchestrator.durationMs ?? 0]]);
  for (const p of agentPhases) {
    const ms = p.workMs ?? p.durationMs;
    byAgent.set(p.agentType, (byAgent.get(p.agentType) || 0) + ms);
  }
  return [...byAgent].map(([agent, ms]) => ({ agent, ms })).sort((a, b) => b.ms - a.ms);
}

// Active-work time of a phase = sum of tool durations + thinking gaps
// between consecutive tools (only when the gap is short enough to plausibly
// be the model deciding what to do next, not a long idle wait on a peer).
//
// SendMessage is excluded from both the tool duration AND the gap span: its
// duration contains the validate-before-review hook (typecheck + tests, often
// 60-150s) which is not active work for the sender. Long gaps after a
// SendMessage are also waits, not thinking — they get clipped by the threshold.
//
// THINKING_GAP_THRESHOLD: bumped to 60s based on observed traces where the
// orchestrator legitimately thinks ~30-50s when classifying a request or
// drafting a plan. Anything beyond a minute is almost certainly an idle wait.
const COMM_TOOLS = new Set(['SendMessage']);
const THINKING_GAP_THRESHOLD = 60000;

function computePhaseWorkMs(phase) {
  const tools = (phase.children || [])
    .filter((c) => c.kind === 'tool_use' || c.kind === 'skill')
    .filter((c) => !(c.kind === 'tool_use' && COMM_TOOLS.has(c.tool)))
    .map((c) => ({
      ts: c.ts || c.startTs,
      durationMs: c.durationMs || 0,
    }))
    .filter((c) => c.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (tools.length === 0) return 0;
  let active = 0;
  let prevEndMs = null;
  for (const t of tools) {
    const startMs = new Date(t.ts).getTime();
    if (prevEndMs !== null) {
      const gap = startMs - prevEndMs;
      if (gap > 0 && gap < THINKING_GAP_THRESHOLD) active += gap;
    }
    active += t.durationMs;
    prevEndMs = startMs + t.durationMs;
  }
  return active;
}

function buildPhaseOwnerMap(events, agentPhases) {
  const phaseByToolUseId = new Map();
  for (const p of agentPhases) if (p._toolUseId) phaseByToolUseId.set(p._toolUseId, p);
  return phaseByToolUseId;
}

function resolvePhase(ev, phaseByToolUseId) {
  const cursor = ev.parent_tool_use_id;
  if (cursor && phaseByToolUseId.has(cursor)) return phaseByToolUseId.get(cursor);
  return null;
}

function toolDetail(toolName, input) {
  if (!input) return null;
  const short = (s, n = 80) => (typeof s === 'string' && s.length > n) ? '…' + s.slice(-n) : s;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': return short(input.file_path);
    case 'Bash': return short(input.command, 80);
    case 'Grep': return `"${input.pattern ?? ''}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob': return input.pattern ?? null;
    case 'Skill': return input.skill ?? null;
    case 'Agent':
    case 'Task': return `${input.subagent_type || '?'}: ${(input.description || '').slice(0, 70)}`;
    case 'TeamCreate': return `team=${input.team_name || '?'}`;
    case 'TeamDelete': return `team=${input.team_name || '?'}`;
    case 'SendMessage': return sendMessageDetail(input);
    default: return null;
  }
}

// Classify a SendMessage's semantic intent. Used both for the icon prefix in
// the detail string AND as a separate `verdict` field on the child so the
// renderer can colour-code rows (red BLOCKED, orange AWR, etc.).
function sendMessageVerdict(text) {
  if (/shutdown_request/i.test(text)) return 'shutdown';
  // Order matters: AWR before plain APPROVED.
  if (/^APPROVED\s+WITH\s+RESERVATIONS\b/i.test(text)) return 'awr';
  if (/^APPROVED\b/i.test(text)) return 'approved';
  if (/^BLOCKED\b/i.test(text) || /^RED\b/i.test(text)) return 'blocked';
  if (/^GREEN\b/i.test(text)) return 'approved';
  if (/\bready\b.*\b(review|validate|merge)\b/i.test(text) || /^GO\b/.test(text)) return 'ready';
  if (/^merged\s+TASK-/i.test(text) || /merge\s+failed/i.test(text)) return 'merger-report';
  return null;
}

const VERDICT_ICON = {
  shutdown: '🛑', awr: '🟡', approved: '✅', blocked: '❌',
  ready: '📨', 'merger-report': '🔀',
};

// SendMessage detail: highlight the verdict semantics so reviewers'
// APPROVED/BLOCKED replies and devs' "ready, please review" pings stand out
// in the timeline. Reduces guesswork when scanning the chronology.
function sendMessageDetail(input) {
  const to = input.to || '?';
  const raw = input.message;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '');
  const head = text.slice(0, 60);
  const verdict = sendMessageVerdict(text);
  const tag = verdict ? VERDICT_ICON[verdict] : '';
  return `${tag ? tag + ' ' : ''}→ ${to}${head ? ' :: ' + head : ''}`;
}

function sendMessageVerdictFromInput(input) {
  const raw = input?.message;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '');
  return sendMessageVerdict(text);
}

// Tool calls excluded from per-phase children. Keep dispatch-control verbs
// (Agent/Task/TeamCreate/TeamDelete) visible in the orchestrator timeline —
// previously they were skipped, leaving an unexplained 1-2min gap between
// the planner's reply and the first dev's GO.
const SKIP_CHILD = new Set();

function buildToolResultMap(events) {
  const m = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'user') continue;
    for (const b of extractToolResultsFromUser(rec.event)) {
      if (b.tool_use_id && !m.has(b.tool_use_id)) m.set(b.tool_use_id, rec.ts);
    }
  }
  return m;
}

const THINKING_PREVIEW_MAX_CHARS = 300;

function previewFromBuffer(buf) {
  if (!buf || buf.length === 0) return null;
  const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return null;
  return joined.length > THINKING_PREVIEW_MAX_CHARS
    ? joined.slice(0, THINKING_PREVIEW_MAX_CHARS - 1) + '…'
    : joined;
}

async function populateChildrenAndCounts(events, phases, orchestrator, claudeSessionId) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const toolResultTsByToolUseId = buildToolResultMap(events);
  const eventTsIndex = buildEventTsIndex(events);
  const toolCounts = new Map();
  const allToolCalls = [];
  const lastToolResultTsByPhase = new Map();
  const thinkingBufferByPhase = new Map();

  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    const owner = resolvePhase(rec.event, phaseByToolUseId) ?? orchestrator;
    if (!owner) continue;
    const blocks = rec.event.message?.content || [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking) {
        const buf = thinkingBufferByPhase.get(owner.phaseId) || [];
        buf.push(b.thinking);
        thinkingBufferByPhase.set(owner.phaseId, buf);
      } else if (b.type === 'text' && b.text) {
        const buf = thinkingBufferByPhase.get(owner.phaseId) || [];
        buf.push(b.text);
        thinkingBufferByPhase.set(owner.phaseId, buf);
      }
    }
    const allUses = blocks.filter((b) => b.type === 'tool_use');
    if (allUses.length === 0) continue;

    // Every tool_use (including dispatches like Agent/Team*) advances the phase's
    // wall-clock cursor — a subagent running is not orchestrator thinking time.
    // Track the max tool_result ts across all of them so the next "thinking" gap
    // measures from when the prior work actually finished.
    let maxToolResultTsThisMsg = null;
    for (const b of allUses) {
      const toolResultTs = toolResultTsByToolUseId.get(b.id) ?? null;
      if (toolResultTs && (!maxToolResultTsThisMsg || toolResultTs > maxToolResultTsThisMsg)) {
        maxToolResultTsThisMsg = toolResultTs;
      }
    }

    const visibleUses = allUses.filter((b) => !SKIP_CHILD.has(b.name));
    if (visibleUses.length > 0) {
      const lastTR = lastToolResultTsByPhase.get(owner.phaseId);
      if (lastTR) {
        const gapMs = msBetween(lastTR, rec.ts);
        if (gapMs >= STREAM_GAP_THRESHOLD_MS) {
          const preview = previewFromBuffer(thinkingBufferByPhase.get(owner.phaseId));
          const eventsDuringGap = countEventsStrictlyBetween(eventTsIndex, lastTR, rec.ts);
          owner.children.push({
            kind: 'stream_gap', ts: lastTR, durationMs: gapMs,
            eventsDuringGap, preview,
          });
        }
      }
      thinkingBufferByPhase.set(owner.phaseId, []);
      for (const b of visibleUses) {
        const toolResultTs = toolResultTsByToolUseId.get(b.id) ?? null;
        const durationMs = toolResultTs ? Math.max(0, msBetween(rec.ts, toolResultTs)) : 0;
        const isApprox = !toolResultTs;
        if (b.name === 'Skill') {
          owner.children.push({
            kind: 'skill',
            skill: b.input?.skill || 'unknown',
            ts: rec.ts, durationMs, isApprox,
          });
        } else {
          owner.children.push({
            kind: 'tool_use',
            tool: b.name, detail: toolDetail(b.name, b.input),
            ts: rec.ts, durationMs, isApprox,
            agentType: owner.agentType,
            verdict: b.name === 'SendMessage' ? sendMessageVerdictFromInput(b.input) : null,
          });
          const tc = toolCounts.get(b.name) || { tool: b.name, count: 0, totalDurationMs: 0 };
          tc.count++; tc.totalDurationMs += durationMs;
          toolCounts.set(b.name, tc);
          allToolCalls.push({
            phaseId: owner.phaseId, tool: b.name, detail: toolDetail(b.name, b.input),
            durationMs, isApprox,
            teamName: owner.teamName ?? null,
            flaggedSlow: durationMs > 30000,
            ts: rec.ts, _toolUseId: b.id,
          });
        }
      }
    }
    lastToolResultTsByPhase.set(owner.phaseId, maxToolResultTsThisMsg ?? rec.ts);
  }

  // Enrich COMPLEX team members (task_type='in_process_teammate') with their
  // tool calls — those live in `~/.claude/projects/-app/<claudeSessionId>/subagents/agent-<task_id>.jsonl`,
  // never streamed into the orchestrator's main log. Without this, every
  // COMPLEX agent phase shows up empty in the stats UI.
  if (claudeSessionId) {
    await enrichSubagentChildren(phases, claudeSessionId, toolCounts, allToolCalls);
  }

  for (const c of allToolCalls) delete c._toolUseId;

  return {
    toolCounts: [...toolCounts.values()].sort((a, b) => b.count - a.count),
    allToolCalls,
  };
}

async function enrichSubagentChildren(phases, claudeSessionId, toolCounts, allToolCalls) {
  // The Claude CLI stores per-subagent transcripts under ~/.claude/projects/
  // The project dir is derived from cwd ('/app' → '-app'). Hardcoding '-app'
  // matches our container layout (chat-service spawns claude with cwd=/app).
  const baseDir = join(homedir(), '.claude', 'projects', '-app', claudeSessionId, 'subagents');

  // Only target COMPLEX team members. Local agents (planner, simple-developer)
  // already have their tool_uses in the main stream via parent_tool_use_id —
  // loading their subagent files would double-count.
  const targets = phases.filter((p) =>
    p.kind === 'agent' && p.taskType === 'in_process_teammate' && p.agentName
  );
  if (targets.length === 0) return;

  let dirEntries;
  try {
    const { readdir } = await import('node:fs/promises');
    dirEntries = await readdir(baseDir);
  } catch {
    return; // dir absent (no team ran yet, or different layout)
  }
  const { stat } = await import('node:fs/promises');

  // Each agent activation (initial dispatch + every SendMessage wake-up) writes
  // a NEW agent-<taskId>.jsonl, but each one is a CUMULATIVE transcript of the
  // entire team session up to that point — sharing the same first-message uuid.
  // Loading every file would replay every tool_use N times. Strategy:
  //
  // 1. Read each .meta.json + the first JSONL line to get firstUuid + size.
  // 2. Group files by (agentName, firstUuid) — that identifies one team session
  //    activation. Keep only the LARGEST file per group (the latest snapshot
  //    contains every prior event).
  // 3. Sort the surviving files by mtime ASC, then align them with the phases
  //    sorted by startTs ASC (same agentName can appear in multiple waves —
  //    e.g. shared "merger" across two TeamCreate cycles).
  const fileMeta = [];
  for (const entry of dirEntries) {
    if (!entry.endsWith('.meta.json')) continue;
    const baseName = entry.slice(0, -'.meta.json'.length);
    const metaPath = join(baseDir, entry);
    const jsonlPath = join(baseDir, baseName + '.jsonl');
    let meta;
    try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { continue; }
    if (!meta.agentType) continue;
    let st;
    try { st = await stat(jsonlPath); } catch { continue; }
    const firstUuid = await readFirstUuid(jsonlPath);
    if (!firstUuid) continue;
    fileMeta.push({
      path: jsonlPath, agentName: meta.agentType,
      firstUuid, size: st.size, mtimeMs: st.mtimeMs,
    });
  }

  // Group by (agentName, firstUuid), pick largest per group.
  const winnersByName = new Map(); // agentName → [{path, mtimeMs}, …]
  const groups = new Map(); // key=name|firstUuid → best
  for (const f of fileMeta) {
    const k = f.agentName + '|' + f.firstUuid;
    const cur = groups.get(k);
    if (!cur || cur.size < f.size) groups.set(k, f);
  }
  for (const f of groups.values()) {
    const list = winnersByName.get(f.agentName) || [];
    list.push(f);
    winnersByName.set(f.agentName, list);
  }

  const phasesByName = new Map();
  for (const p of targets) {
    const list = phasesByName.get(p.agentName) || [];
    list.push(p);
    phasesByName.set(p.agentName, list);
  }

  for (const [name, phasesForName] of phasesByName) {
    const winners = (winnersByName.get(name) || []).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const phasesSorted = [...phasesForName].sort((a, b) => a.startTs.localeCompare(b.startTs));
    const n = Math.min(winners.length, phasesSorted.length);
    for (let i = 0; i < n; i++) {
      await appendSubagentToolUses(winners[i].path, phasesSorted[i], toolCounts, allToolCalls);
    }
  }
}

async function readFirstUuid(jsonlPath) {
  // Read just the first line to extract its uuid — used as a stable identity
  // for "this team-session activation" across cumulative resume snapshots.
  try {
    for await (const ev of readJsonl(jsonlPath)) {
      return ev?.uuid ?? null;
    }
  } catch { /* empty or unreadable */ }
  return null;
}

async function appendSubagentToolUses(file, phase, toolCounts, allToolCalls) {
  const events = [];
  try {
    for await (const ev of readJsonl(file)) events.push(ev);
  } catch { return; }

  // tool_result timestamps for duration computation
  const toolResultTsById = new Map();
  for (const e of events) {
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c.type === 'tool_result' && c.tool_use_id) {
        toolResultTsById.set(c.tool_use_id, e.timestamp);
      }
    }
  }

  // Per-message dedup for tokens: each tool_use generates two assistant events
  // sharing the same `message.id` — once we decide to use a tool, then again
  // after streaming. Only the second carries the final usage; both can have
  // partial usage. Sum tokens only from the FIRST occurrence per message id
  // to avoid double-count.
  const tokensByMessageId = new Set();

  for (const e of events) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    const u = e.message?.usage;
    const msgId = e.message?.id;
    if (u && msgId && !tokensByMessageId.has(msgId)) {
      tokensByMessageId.add(msgId);
      // Same formula as chat-service stats: input + cache_creation + output.
      // cache_read is intentionally excluded — cheap rehydration, not billed
      // against the user's working set.
      const t = (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.output_tokens || 0);
      phase.tokensTotal = (phase.tokensTotal || 0) + t;
    }

    for (const b of e.message.content) {
      if (b.type !== 'tool_use' || SKIP_CHILD.has(b.name)) continue;
      phase.opsCount = (phase.opsCount || 0) + 1;

      const trTs = toolResultTsById.get(b.id) ?? null;
      const durationMs = trTs ? Math.max(0, msBetween(e.timestamp, trTs)) : 0;
      const isApprox = !trTs;
      if (b.name === 'Skill') {
        phase.children.push({
          kind: 'skill', skill: b.input?.skill || 'unknown',
          ts: e.timestamp, durationMs, isApprox,
        });
      } else {
        phase.children.push({
          kind: 'tool_use',
          tool: b.name, detail: toolDetail(b.name, b.input),
          ts: e.timestamp, durationMs, isApprox,
          agentType: phase.agentType,
          verdict: b.name === 'SendMessage' ? sendMessageVerdictFromInput(b.input) : null,
        });
        const tc = toolCounts.get(b.name) || { tool: b.name, count: 0, totalDurationMs: 0 };
        tc.count++; tc.totalDurationMs += durationMs;
        toolCounts.set(b.name, tc);
        allToolCalls.push({
          phaseId: phase.phaseId, tool: b.name, detail: toolDetail(b.name, b.input),
          durationMs, isApprox,
          teamName: phase.teamName ?? null,
          flaggedSlow: durationMs > 30000,
          ts: e.timestamp,
        });
      }
    }
  }
}

function buildTopAgents(agentPhases) {
  return [...agentPhases].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map((p) => ({ phaseId: p.phaseId, label: `${p.agentType} ${p.description}`.trim(), durationMs: p.durationMs, teamName: p.teamName }));
}

function buildTopToolCalls(allToolCalls) {
  return [...allToolCalls].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map(({ ts, ...rest }) => rest);
}

const HOOK_NAME_MAP = {
  'typecheck': 'typecheck-on-commit.sh',
  'unit-app':  'run-unit-tests-app.sh',
  'unit-fn':   'run-unit-tests-functions.sh',
  'e2e':       'run-e2e-tests.sh',
  'prettier':  'prettier-on-stop.sh',
  'block-bash-file-write': 'block-bash-file-write.sh',
  'block-bash-validation': 'block-bash-validation.sh',
  'circuit-breaker':       'circuit-breaker.sh',
  'silent-mode-check':     'silent-mode-check.sh',
};
const BLOCKING_HOOKS = new Set([
  'block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh',
]);

function parseHookLine(line) {
  const m = line.match(/^\[([^\]]+)\]\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  const [, ts, shortName, state, rest = ''] = m;
  const wtMatch = rest.match(/wt=(\S+)/);
  const worktree = wtMatch ? wtMatch[1] : null;
  let kind = null, exitCode = null;
  if (state === 'START') kind = 'start';
  else if (state === 'SKIP') kind = 'skip';
  else if (state === 'OK') kind = 'ok';
  else if (state === 'FAIL') {
    kind = 'fail';
    const em = rest.match(/EXIT=(\d+)/);
    exitCode = em ? Number(em[1]) : 2;
  }
  else if (state.startsWith('EXIT=')) { kind = 'exit'; exitCode = Number(state.slice(5)); }
  return { ts, shortName, kind, exitCode, worktree, rest };
}

async function readHooksLog(path, winStart, winEnd) {
  if (!path) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  const ws = winStart ? new Date(winStart).getTime() : 0;
  const we = winEnd ? new Date(winEnd).getTime() : Infinity;
  for (const l of lines) {
    const p = parseHookLine(l);
    if (!p) continue;
    const t = new Date(p.ts).getTime();
    if (Number.isNaN(t) || t < ws || t > we) continue;
    out.push(p);
  }
  return out;
}

function aggregateHooks(hookLines) {
  // A "run" is bracketed by START / EXIT in the log. Inside, the script logs
  // per-worktree OK or FAIL lines (each with wt=…). We prefer those as
  // executions because they carry the worktree info needed to attach hooks
  // to the right phase in the timeline. The wrap-up EXIT line carries no
  // worktree, so we only emit it as an execution when the run produced no
  // per-worktree result (e.g. e2e, which doesn't loop on worktrees).
  const openByName = new Map(); // shortName → { ts, sawPerWorktree }
  const execsByName = new Map();
  for (const line of hookLines) {
    const fullName = HOOK_NAME_MAP[line.shortName] || `${line.shortName}.sh`;
    if (!execsByName.has(fullName)) execsByName.set(fullName, []);
    if (line.kind === 'start') {
      openByName.set(line.shortName, { ts: line.ts, sawPerWorktree: false });
    } else if (line.kind === 'ok' || line.kind === 'fail') {
      const start = openByName.get(line.shortName);
      if (start) start.sawPerWorktree = true;
      const startTs = start?.ts ?? line.ts;
      execsByName.get(fullName).push({
        ts: startTs,
        worktree: line.worktree ?? null,
        durationMs: msBetween(startTs, line.ts),
        exitCode: line.kind === 'ok' ? 0 : (line.exitCode ?? 2),
        tail: null,
      });
    } else if (line.kind === 'exit') {
      const start = openByName.get(line.shortName);
      const startTs = start?.ts ?? line.ts;
      openByName.delete(line.shortName);
      if (!start?.sawPerWorktree) {
        execsByName.get(fullName).push({
          ts: startTs, worktree: line.worktree ?? null,
          durationMs: msBetween(startTs, line.ts),
          exitCode: line.exitCode, tail: null,
        });
      }
    } else if (line.kind === 'skip') {
      execsByName.get(fullName).push({
        ts: line.ts, worktree: line.worktree, durationMs: 0, exitCode: null, skip: true, tail: null,
      });
    }
  }
  const out = [];
  for (const [fullName, execs] of execsByName) {
    const runs = execs.filter((e) => !e.skip).length;
    out.push({
      hookName: fullName,
      hookType: BLOCKING_HOOKS.has(fullName) ? 'PreToolUse' : 'SubagentStop',
      runs,
      totalDurationMs: execs.reduce((a, e) => a + (e.durationMs || 0), 0),
      okCount: execs.filter((e) => !e.skip && e.exitCode === 0).length,
      failCount: execs.filter((e) => !e.skip && e.exitCode !== 0 && e.exitCode !== null).length,
      skipCount: execs.filter((e) => e.skip).length,
      blocking: BLOCKING_HOOKS.has(fullName),
      executions: execs,
    });
  }
  return out.sort((a, b) => b.runs - a.runs);
}

function extractWorktreeFromAgentPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  // SIMPLE flow uses `WORKTREE_PATH=…`; COMPLEX team prompts use `WORKTREE: …`.
  // Match both so hook executions can be attached to the right phase regardless
  // of which dispatch path produced the agent.
  const m = prompt.match(/WORKTREE(?:_PATH)?[=:]\s*(\S+)/);
  return m ? m[1] : null;
}

function assignHookExecsToPhases(events, phases, hookAggregates) {
  const worktreeByPhaseId = new Map();
  const toolUseIdToWorktree = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.prompt) {
        const wt = extractWorktreeFromAgentPrompt(b.input.prompt);
        if (wt) toolUseIdToWorktree.set(b.id, wt);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.tool_use_id && toolUseIdToWorktree.has(ev.tool_use_id)) {
      worktreeByPhaseId.set(ev.task_id, toolUseIdToWorktree.get(ev.tool_use_id));
    }
  }
  const phaseIdByWorktree = new Map();
  for (const [phaseId, wt] of worktreeByPhaseId) phaseIdByWorktree.set(wt, phaseId);
  for (const agg of hookAggregates) {
    for (const exec of agg.executions) {
      if (!exec.worktree) continue;
      const phaseId = phaseIdByWorktree.get(exec.worktree);
      if (!phaseId) continue;
      const phase = phases.find((p) => p.phaseId === phaseId);
      if (!phase) continue;
      phase.children.push({
        kind: 'hook',
        hookName: agg.hookName, hookType: agg.hookType,
        worktree: exec.worktree,
        startTs: exec.ts,
        endTs: exec.ts && exec.durationMs ? new Date(new Date(exec.ts).getTime() + exec.durationMs).toISOString() : exec.ts,
        durationMs: exec.durationMs,
        exitCode: exec.exitCode,
        result: exec.skip ? 'skip' : (exec.exitCode === 0 ? 'ok' : 'fail'),
      });
    }
  }
}

function aggregateSkills(phases) {
  const byName = new Map();
  for (const phase of phases) {
    for (const child of phase.children) {
      if (child.kind !== 'skill') continue;
      const row = byName.get(child.skill) ?? { skill: child.skill, count: 0, totalDurationMs: 0, invocations: [] };
      row.count++;
      row.totalDurationMs += child.durationMs || 0;
      row.invocations.push({ ts: child.ts, agentType: phase.agentType, phaseId: phase.phaseId });
      byName.set(child.skill, row);
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

const RULE_PATH_RE = /\.claude\/rules\/([^/]+\.md)$/;

function aggregateRules(events, phases) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const byFile = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name !== 'Read') continue;
      const m = typeof b.input?.file_path === 'string' && b.input.file_path.match(RULE_PATH_RE);
      if (!m) continue;
      const ruleFile = m[1];
      const owner = resolvePhase(rec.event, phaseByToolUseId);
      const agentType = owner?.agentType ?? 'orchestrator';
      const row = byFile.get(ruleFile) ?? { ruleFile, reads: 0, readers: new Map() };
      row.reads++;
      row.readers.set(agentType, (row.readers.get(agentType) || 0) + 1);
      byFile.set(ruleFile, row);
    }
  }
  return [...byFile.values()]
    .map((r) => ({
      ruleFile: r.ruleFile, reads: r.reads,
      readers: [...r.readers].map(([agentType, count]) => ({ agentType, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.reads - a.reads);
}

function tailPayload(obj, maxLen = 800) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  } catch { return null; }
}

function detectErrors(events, phases, hooks) {
  const errs = [];
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'notification' && ev.priority === 'immediate') {
      errs.push({ kind: 'notification', ts: rec.ts, phaseId: null, teamName: null,
        summary: ev.text || ev.key || 'notification', payload: tailPayload(ev) });
    } else if (ev.type === 'result' && ev.is_error) {
      errs.push({ kind: 'turn_error', ts: rec.ts, phaseId: null, teamName: null,
        summary: `Turn failed: ${ev.api_error_status || ev.result || 'error'}`, payload: tailPayload(ev) });
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && ev.status === 'failed') {
      const phase = phases.find((p) => p.phaseId === ev.task_id);
      errs.push({ kind: 'task_failed', ts: rec.ts, phaseId: ev.task_id, teamName: phase?.teamName ?? null,
        summary: `${phase?.description ?? ev.task_id} failed`, payload: tailPayload(ev) });
    }
  }
  for (const h of hooks) {
    if (h.blocking) continue;
    for (const e of h.executions) {
      if (e.exitCode != null && e.exitCode !== 0) {
        errs.push({ kind: 'hook_failed', ts: e.ts, phaseId: null, teamName: null,
          summary: `${h.hookName} EXIT=${e.exitCode}`,
          payload: { hookName: h.hookName, worktree: e.worktree, exitCode: e.exitCode } });
      }
    }
  }
  return errs.sort((a, b) => a.ts.localeCompare(b.ts));
}

function commonPrefixRatio(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return Math.max(a.length, b.length) === 0 ? 1 : i / Math.max(a.length, b.length);
}

function detectRetries(phases, errors) {
  const retries = [];
  const sortedAgents = phases.filter((p) => p.kind === 'agent').sort((a, b) => a.startTs.localeCompare(b.startTs));
  const retrySet = new Set();

  const SUFFIX = /\((retry|after [^)]+)\)\s*$/i;
  for (const p of sortedAgents) {
    if (SUFFIX.test(p.description)) {
      retries.push({ ts: p.startTs, triggeredByErrorTs: null, phaseId: p.phaseId,
        description: p.description, matchMethod: 'suffix-parens-retry' });
      retrySet.add(p.phaseId);
    }
  }

  for (const err of errors.filter((e) => e.kind === 'task_failed')) {
    const errPhase = sortedAgents.find((p) => p.phaseId === err.phaseId);
    if (!errPhase) continue;
    const windowEnd = new Date(err.ts).getTime() + 5 * 60 * 1000;
    const cand = sortedAgents.find((p) =>
      !retrySet.has(p.phaseId) &&
      p.startTs > err.ts &&
      new Date(p.startTs).getTime() <= windowEnd &&
      commonPrefixRatio(errPhase.description, p.description) > 0.8
    );
    if (cand) {
      retries.push({ ts: cand.startTs, triggeredByErrorTs: err.ts, phaseId: cand.phaseId,
        description: cand.description, matchMethod: 'failure-followed-by-similar' });
      retrySet.add(cand.phaseId);
    }
  }

  for (let i = 0; i < sortedAgents.length; i++) {
    for (let j = i + 1; j < sortedAgents.length; j++) {
      const a = sortedAgents[i], b = sortedAgents[j];
      if (retrySet.has(b.phaseId) || a.description !== b.description) continue;
      if (new Date(b.startTs).getTime() - new Date(a.startTs).getTime() > 5 * 60 * 1000) continue;
      retries.push({ ts: b.startTs, triggeredByErrorTs: null, phaseId: b.phaseId,
        description: b.description, matchMethod: 'duplicate-description-5min' });
      retrySet.add(b.phaseId);
    }
  }

  return retries.sort((a, b) => a.ts.localeCompare(b.ts));
}

// Read TASK-*.json files from the session directory and compute their wave
// number from the dependency graph (Kahn's algorithm — every ticket whose
// deps are already merged moves into the next wave). Returns null if the
// session has no ticket files (SIMPLE flow, planner failed, ...).
async function loadTicketsAndWaves(sessionDir) {
  let entries;
  try { entries = await readdir(sessionDir); } catch { return null; }
  const taskFiles = entries.filter((n) => /^TASK-\d+\.json$/.test(n));
  if (taskFiles.length === 0) return null;
  const tickets = [];
  for (const f of taskFiles) {
    try {
      const t = JSON.parse(await readFile(join(sessionDir, f), 'utf8'));
      tickets.push({
        id: t.ticket_id || f.replace(/\.json$/, ''),
        title: t.title || '',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        parallelSafe: t.parallel_safe !== false,
        status: t.status || 'pending',
        riskLevel: t.risk_level || null,
      });
    } catch { /* skip malformed */ }
  }
  // Topological wave assignment
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const remaining = new Set(tickets.map((t) => t.id));
  const waves = [];
  let safety = tickets.length + 1; // protect against dep cycles
  while (remaining.size > 0 && safety-- > 0) {
    const ready = [...remaining].filter((id) => {
      const t = byId.get(id);
      return t.dependencies.every((d) => !remaining.has(d));
    });
    if (ready.length === 0) {
      // Cycle or unresolvable dep — drop the rest into a final "stuck" wave.
      waves.push([...remaining]);
      break;
    }
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  for (let i = 0; i < waves.length; i++) {
    for (const id of waves[i]) byId.get(id).wave = i + 1;
  }
  return { tickets: tickets.sort((a, b) => a.id.localeCompare(b.id)), waves };
}

export async function aggregateSession({ sessionLogPath, hooksLogPath, sessionId }) {
  const events = [];
  for await (const ev of readJsonl(sessionLogPath)) events.push(ev);

  // Session bounds: ignore client-noise events that fire on tab open / WebSocket
  // reconnect (`init`, `progress`, `status`, `state`, `stats`, `choices`,
  // `title`). They can land long after the actual conversation finishes —
  // observed: a reconnect 32 minutes after the last reply pushed totalMs from
  // 17 min to 50 min. Real session boundaries come from substantive events:
  // user_message, message, debug_raw (Claude SDK stream), error.
  const SUBSTANTIVE = new Set(['user_message', 'message', 'debug_raw', 'error']);
  const substantive = events.filter((ev) => ev.ts && SUBSTANTIVE.has(ev.type));
  const startTs = substantive[0]?.ts ?? events[0]?.ts ?? null;
  const endTs = substantive[substantive.length - 1]?.ts ?? events[events.length - 1]?.ts ?? null;
  const durationMs = startTs && endTs ? msBetween(startTs, endTs) : 0;

  // Read claudeSessionId from meta.json (sibling of log.jsonl) — needed to
  // locate per-subagent transcripts under ~/.claude/projects/-app/<id>/subagents/.
  let claudeSessionId = null;
  try {
    const meta = JSON.parse(await readFile(join(dirname(sessionLogPath), 'meta.json'), 'utf8'));
    claudeSessionId = meta.claudeSessionId ?? null;
  } catch { /* meta missing or unreadable — subagent enrichment will be skipped */ }

  const s = computeSummary(events);

  const { teams, agentToolIdToTeam } = extractTeams(events);
  const agentPhases = extractPhases(events, agentToolIdToTeam);

  for (const p of agentPhases) {
    if (p.teamName && teams.has(p.teamName)) {
      const t = teams.get(p.teamName);
      t.agentsCount++;
      t.durationMs += p.durationMs;
    }
  }

  const orchestrator = buildOrchestratorPhase(events, agentPhases, startTs, endTs);
  const phases = [orchestrator, ...agentPhases].sort((a, b) => a.startTs.localeCompare(b.startTs));

  // Build phase children, tool counts, and leaderboards.
  // Must run before workMs/timeBreakdown so children are populated.
  const { toolCounts, allToolCalls } = await populateChildrenAndCounts(events, phases, orchestrator, claudeSessionId);

  // Derive workMs (active-work time) per phase from the tool_use children.
  // For COMPLEX team members, durationMs includes long idle waits — workMs
  // is the actual hands-on-keyboard time.
  for (const p of phases) p.workMs = computePhaseWorkMs(p);

  const timeBreakdown = agentPhases.length > 0 ? buildTimeBreakdown(orchestrator, agentPhases) : [];

  // Add the COMPLEX subagents' tokens/ops to the session-level summary.
  // computeSummary only sees the orchestrator's main log; subagent transcripts
  // (loaded by enrichSubagentChildren) carry the bulk of the work for COMPLEX
  // runs and must be added so the dashboard totals match reality.
  let extraOps = 0, extraTokens = 0;
  for (const p of agentPhases) {
    if (p.taskType === 'in_process_teammate') {
      extraOps += p.opsCount || 0;
      extraTokens += p.tokensTotal || 0;
    }
  }
  s.opsCount += extraOps;
  s.tokensTotal += extraTokens;

  // Only keep phases if orchestrator has children or if there are agent phases
  const hasOrchestratorWork = orchestrator.children.length > 0;
  const finalPhases = (hasOrchestratorWork || agentPhases.length > 0) ? phases : [];

  const topAgents = buildTopAgents(agentPhases);
  const topToolCalls = buildTopToolCalls(allToolCalls);

  // Read and correlate hooks.log
  const hookLines = await readHooksLog(hooksLogPath, startTs, endTs);
  const hooks = aggregateHooks(hookLines);
  assignHookExecsToPhases(events, phases, hooks);

  // Sort each phase's children chronologically so tools and hooks interleave
  // in the timeline rather than tools-then-hooks (hooks are pushed last so
  // their MM:SS would otherwise sit at the bottom of the row but with earlier
  // timestamps than the trailing tools).
  const childTs = (c) => c.ts || c.startTs || '';
  for (const p of phases) {
    p.children.sort((a, b) => childTs(a).localeCompare(childTs(b)));
  }

  // Aggregate skills and rules
  const skills = aggregateSkills(finalPhases);
  const rules = aggregateRules(events, finalPhases);

  // Detect errors and retries
  const errors = detectErrors(events, phases, hooks);
  const retries = detectRetries(phases, errors);

  // Propagate error and retry counts to phases and teams
  for (const p of phases) {
    p.errorsCount = errors.filter((e) => e.phaseId === p.phaseId).length;
    p.retriesCount = retries.filter((r) => r.phaseId === p.phaseId).length;
  }
  for (const t of teams.values()) {
    t.errorsCount = errors.filter((e) => e.teamName === t.team_name).length;
  }

  return {
    sessionId: sessionId ?? null,
    logPath: sessionLogPath,
    startTs,
    endTs,
    durationMs,
    summary: {
      totalMs: durationMs,
      agentsCount: agentPhases.length,
      opsCount: s.opsCount,
      tokensTotal: s.tokensTotal,
      costUsd: s.costUsd,
      errorsCount: errors.length,
      retriesCount: retries.length,
      timeBreakdown,
    },
    teams: [...teams.values()],
    phases: finalPhases,
    topAgents,
    topToolCalls,
    toolCounts,
    skills, hooks, rules, errors, retries,
    ...(await loadTicketsAndWaves(dirname(sessionLogPath))) ?? {},
  };
}
