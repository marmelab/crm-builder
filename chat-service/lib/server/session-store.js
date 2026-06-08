import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LOG_DIR, UUID_RE, ALLOWED_STATES } from './config.js';
import {
  emptyBreakdown, addBreakdown, breakdownFromModelUsage, breakdownFromUsage,
  costFromBreakdown,
} from '../stats/io.js';

// True when COMPLEX ticket files (TASK-NNN.json) exist in the session dir — i.e.
// the planner produced a wave and the orchestrator dispatched (or was about to
// dispatch) a team. Resume routing uses this: if a wave was in flight when the
// process was killed, --resume would reinject the dead "team is running" belief,
// so the resume must spawn fresh and re-evaluate real state instead. Takes the
// session dir (not an id) so it's testable without LOG_DIR coupling — mirrors
// sessionHasMergedTickets in documentator-spawn.js.
export async function sessionHasTickets(sessionDir) {
  try {
    const entries = await readdir(sessionDir);
    return entries.some((e) => /^TASK-\d+\.json$/i.test(e));
  } catch {
    return false;
  }
}

// ─── Session persistence ──────────────────────────────────────
// Single source of truth = log.jsonl (append-only stream of ws in/out events).
// meta.json holds only lightweight metadata (title, timestamps, counts,
// claudeSessionId) so the listing page doesn't have to parse every log.
// Visible messages (user + assistant) are derived from log.jsonl on demand.

// Cap on debug events replayed to a (re)joining client. Matches the client's
// in-memory buffer cap (chat-service/public/chat.js: DEBUG_BUFFER_MAX) so a
// freshly-joined tab toggling debug ON sees the same depth as a tab that
// stayed connected through the turn.
const DEBUG_REPLAY_MAX = 1000;

export function digestLog(logText) {
  // Single chronological timeline — message and debug entries appear in the
  // exact order they were logged so a (re)joining client can replay them
  // faithfully (instead of dumping debugs at the end).
  // Items are tagged: { kind: 'message', role, content, ts } or
  //                   { kind: 'debug', type: 'debug'|'debug_raw', ... }.
  const timeline = [];
  // Indices into `timeline` for the debug entries, used to drop the oldest
  // debug items (without touching messages) when DEBUG_REPLAY_MAX is exceeded.
  // Dropped slots are marked null; we filter once at the end.
  const debugSlots = [];
  let droppedAny = false;
  let tokensUsed = 0;
  let costUsd = 0;
  let tokensBreakdown = emptyBreakdown();
  // Per-model accumulator: map<model, breakdown>. modelUsage is cumulative
  // within a spawn → keep the current snapshot, commit the latest into the
  // cross-spawn totals when the spawn ends.
  const tokensByModelMap = new Map();
  let currentSpawnByModel = new Map();
  // Spawn boundaries: every `user_message` in the log starts a new `claude -p`
  // (chat-service spawns one CLI process per user turn). We commit the prior
  // spawn's cumulative cost/tokens on each user_message instead of relying on
  // the older "cost decrease" heuristic, which silently absorbed a spawn
  // whenever its successor's first cost event landed above its own max.
  let userMessageCount = 0;
  let currentSpawnMax = 0;
  let currentSpawnBreakdown = emptyBreakdown();
  let currentSpawnFallback = emptyBreakdown();
  let currentSpawnSawModelUsage = false;
  // queueId → timeline index of the user message it was assigned to. When the
  // matching `cancel_queued` entry is later encountered, we null out that slot
  // so the bubble doesn't reappear on rehydrate.
  const queuedUserMessageSlots = new Map();

  const commitSpawn = () => {
    costUsd += currentSpawnMax;
    if (currentSpawnSawModelUsage) {
      tokensBreakdown = addBreakdown(tokensBreakdown, currentSpawnBreakdown);
      for (const [model, mb] of currentSpawnByModel) {
        const prev = tokensByModelMap.get(model) || { breakdown: emptyBreakdown(), costUsd: 0 };
        tokensByModelMap.set(model, {
          breakdown: addBreakdown(prev.breakdown, mb.breakdown),
          costUsd: prev.costUsd + (mb.costUsd || 0),
        });
      }
    } else {
      tokensBreakdown = addBreakdown(tokensBreakdown, currentSpawnFallback);
    }
    currentSpawnMax = 0;
    currentSpawnBreakdown = emptyBreakdown();
    currentSpawnFallback = emptyBreakdown();
    currentSpawnByModel = new Map();
    currentSpawnSawModelUsage = false;
  };

  const trackDebug = () => {
    debugSlots.push(timeline.length - 1);
    if (debugSlots.length > DEBUG_REPLAY_MAX) {
      const drop = debugSlots.shift();
      timeline[drop] = null;
      droppedAny = true;
    }
  };

  for (const line of logText.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.dir === 'in' && entry.type === 'user_message') {
      if (userMessageCount > 0) commitSpawn();
      userMessageCount++;
      timeline.push({ kind: 'message', role: 'user', content: entry.display || entry.content || '', ts: entry.ts });
      if (entry.queueId != null) queuedUserMessageSlots.set(entry.queueId, timeline.length - 1);
    } else if (entry.dir === 'in' && entry.type === 'cancel_queued') {
      const slot = queuedUserMessageSlots.get(entry.queueId);
      if (slot != null) {
        timeline[slot] = null;
        droppedAny = true;
        queuedUserMessageSlots.delete(entry.queueId);
      }
    } else if (entry.dir === 'in' && entry.type === 'resume_requested') {
      // A "Resume" click replays the last user message — it spawns a fresh
      // claude process, so commit the prior spawn's accumulators here.
      // We don't push a message (the prior user_message is already in the
      // timeline) and don't bump userMessageCount.
      if (userMessageCount > 0) commitSpawn();
    } else if (entry.dir === 'out' && entry.type === 'message' && entry.role === 'assistant') {
      const item = { kind: 'message', role: 'assistant', content: entry.content || '', ts: entry.ts };
      if (entry.subtype) item.subtype = entry.subtype;
      timeline.push(item);
    } else if (entry.dir === 'out' && entry.type === 'debug_raw') {
      if (entry.event?.type === 'result') {
        // total_cost_usd / modelUsage are cumulative WITHIN a spawn. Keep the
        // spawn's running max for cost, and replace the running modelUsage
        // breakdown with the latest snapshot. Cost-decrease is still used as
        // a safety net for sessions that predate user_message logging.
        const c = entry.event.total_cost_usd || 0;
        if (userMessageCount === 0 && c < currentSpawnMax) commitSpawn();
        currentSpawnMax = Math.max(currentSpawnMax, c);
        if (entry.event.modelUsage && Object.keys(entry.event.modelUsage).length > 0) {
          currentSpawnBreakdown = breakdownFromModelUsage(entry.event.modelUsage);
          // Replace per-model snapshot (cumulative-within-spawn). Capture
          // both the token breakdown AND the SDK's authoritative costUSD.
          currentSpawnByModel = new Map();
          for (const [model, mu] of Object.entries(entry.event.modelUsage)) {
            currentSpawnByModel.set(model, {
              breakdown: {
                input:       mu?.inputTokens               || 0,
                cacheCreate: mu?.cacheCreationInputTokens  || 0,
                output:      mu?.outputTokens              || 0,
                cacheRead:   mu?.cacheReadInputTokens      || 0,
              },
              costUsd: typeof mu?.costUSD === 'number' ? mu.costUSD : null,
            });
          }
          currentSpawnSawModelUsage = true;
        }
        // Fallback accumulator: per-turn usage summing (used only when this
        // spawn never emitted modelUsage).
        if (!currentSpawnSawModelUsage) {
          currentSpawnFallback = addBreakdown(currentSpawnFallback, breakdownFromUsage(entry.event.usage));
        }
      }
      timeline.push({ kind: 'debug', type: 'debug_raw', event: entry.event });
      trackDebug();
    } else if (entry.dir === 'out' && entry.type === 'debug') {
      timeline.push({ kind: 'debug', type: 'debug', tool: entry.tool, input: entry.input, agent: entry.agent });
      trackDebug();
    }
  }

  // Commit the trailing spawn.
  commitSpawn();
  tokensUsed = tokensBreakdown.input + tokensBreakdown.cacheCreate + tokensBreakdown.output;
  const cleanTimeline = droppedAny ? timeline.filter((x) => x !== null) : timeline;
  // Back-compat views — same data, just split by kind. Existing callers
  // (readMessages, runtime stats hydration, tests) keep working unchanged.
  const messages = [];
  const recentDebug = [];
  for (const it of cleanTimeline) {
    if (it.kind === 'message') {
      messages.push({ role: it.role, content: it.content, ts: it.ts });
    } else {
      if (it.type === 'debug_raw') recentDebug.push({ type: 'debug_raw', event: it.event });
      else recentDebug.push({ type: 'debug', tool: it.tool, input: it.input, agent: it.agent });
    }
  }
  const tokensByModel = [...tokensByModelMap].map(([model, v]) => ({
    model,
    breakdown: v.breakdown,
    costUsd: v.costUsd != null ? v.costUsd : costFromBreakdown(model, v.breakdown),
  })).sort((a, b) => b.costUsd - a.costUsd);
  return { messages, recentDebug, timeline: cleanTimeline, stats: { tokensUsed, tokensBreakdown, tokensByModel, costUsd } };
}

export async function readDigest(id) {
  try {
    const raw = await readFile(`${LOG_DIR}/${id}/log.jsonl`, 'utf8');
    return digestLog(raw);
  } catch {
    return { messages: [], recentDebug: [], timeline: [], stats: { tokensUsed: 0, tokensBreakdown: emptyBreakdown(), tokensByModel: [], costUsd: 0 } };
  }
}

export async function readMessages(id) {
  return (await readDigest(id)).messages;
}

export async function openSession(requestedId) {
  await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  let id = requestedId && UUID_RE.test(requestedId) ? requestedId : null;
  let meta = null;
  let isNew = false;
  let messages = [];
  let recentDebug = [];
  let timeline = [];
  let stats = { tokensUsed: 0, tokensBreakdown: emptyBreakdown(), tokensByModel: [], costUsd: 0 };

  if (id) {
    try {
      meta = JSON.parse(await readFile(`${LOG_DIR}/${id}/meta.json`, 'utf8'));
      const digest = await readDigest(id);
      messages = digest.messages;
      recentDebug = digest.recentDebug;
      timeline = digest.timeline;
      stats = digest.stats;
    } catch {
      id = null;
      meta = null;
    }
  }

  if (!id) {
    id = randomUUID();
    isNew = true;
    await mkdir(`${LOG_DIR}/${id}`, { recursive: true });
    meta = {
      id,
      title: '',
      state: 'in_progress',
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
      messageCount: 0,
      claudeSessionId: null,
    };
    await writeFile(`${LOG_DIR}/${id}/meta.json`, JSON.stringify(meta, null, 2));
  }

  const logStream = createWriteStream(`${LOG_DIR}/${id}/log.jsonl`, { flags: 'a' });

  const saveMeta = () =>
    writeFile(`${LOG_DIR}/${id}/meta.json`, JSON.stringify(meta, null, 2));

  return {
    id,
    isNew,
    get meta() { return meta; },
    messages,
    // Debug events of the session (sliding window, capped) — kept for callers
    // that don't care about chronological ordering.
    recentDebug,
    // Chronologically-ordered interleave of messages and debug events. Used
    // by the init frame so a refresh paints debugs in their original position
    // relative to the surrounding messages, not bunched at the end.
    timeline,
    // Cumulative tokens/cost reconstructed from the log so the inline ticker
    // survives a runtime teardown (last tab closed) and a page refresh.
    stats,
    logWrite: (dir, data) =>
      logStream.write(JSON.stringify({ ts: new Date().toISOString(), dir, ...data }) + '\n'),
    // Record that a visible message has just been appended to the log (meta side effects only).
    recordMessage: async (role, content) => {
      meta.lastMessageAt = new Date().toISOString();
      meta.messageCount = (meta.messageCount || 0) + 1;
      if (role === 'user') {
        meta.userMessageCount = (meta.userMessageCount || 0) + 1;
        if (!meta.title) meta.title = content.trim().replace(/\s+/g, ' ').slice(0, 60);
        if (meta.satisfactionAsk) meta.satisfactionAsk = false;
      }
      await saveMeta();
    },
    setTitle: async (newTitle, { auto = false } = {}) => {
      meta.title = newTitle;
      if (auto) meta.titleAutoGenerated = true;
      await saveMeta();
    },
    setClaudeSessionId: async (csid) => {
      if (!csid || meta.claudeSessionId === csid) return;
      meta.claudeSessionId = csid;
      await saveMeta();
    },
    setState: async (newState) => {
      if (!ALLOWED_STATES.has(newState) || meta.state === newState) return false;
      meta.state = newState;
      // Any transition away from rate_limited clears the persisted reset
      // timestamp so the UI doesn't keep rendering a stale countdown after the
      // user resumes (state → in_progress) or the session is cancelled.
      if (newState !== 'rate_limited' && meta.rateLimitResetsAt != null) {
        meta.rateLimitResetsAt = null;
      }
      await saveMeta();
      return true;
    },
    setRateLimitResetsAt: async (ts) => {
      const next = typeof ts === 'number' ? ts : null;
      if (meta.rateLimitResetsAt === next) return;
      meta.rateLimitResetsAt = next;
      await saveMeta();
    },
    setSatisfactionAsk: async (payload) => {
      meta.satisfactionAsk = payload;
      await saveMeta();
    },
    // In-memory equivalent of patchSession — keeps the runtime's meta object
    // in sync when an HTTP PATCH lands on a session that's currently active.
    // Without this, a subsequent saveMeta() from the running turn would
    // overwrite the user's change with stale data.
    applyPatch: async (patch) => {
      applyMetaPatch(meta, patch);
      await saveMeta();
      return meta;
    },
    close: () => new Promise((resolve) => logStream.end(resolve)),
  };
}

function applyMetaPatch(meta, patch) {
  if (typeof patch.title === 'string') {
    meta.title = patch.title.slice(0, 200);
    meta.titleLocked = true;
  }
  if (typeof patch.state === 'string' && ALLOWED_STATES.has(patch.state)) {
    meta.state = patch.state;
    // Mirror setState's side-effect: any transition away from rate_limited
    // clears the persisted reset timestamp so a stale countdown doesn't
    // linger on listSessions / refresh.
    if (patch.state !== 'rate_limited' && meta.rateLimitResetsAt != null) {
      meta.rateLimitResetsAt = null;
    }
  }
}

// Heuristic: Claude's final message ends with a question → session is waiting
// for a user reply (e.g. "Quelle couleur préférez-vous ?"). We look at the last
// non-empty paragraph so a mid-message question followed by a conclusion does
// not trigger; a question followed by a trailing code block still falls
// through to 'completed' since the code block becomes the last paragraph.
// Exported for unit testing.
export function endsWithQuestion(text) {
  if (!text) return false;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lastPara = paragraphs[paragraphs.length - 1] || '';
  const trimmed = lastPara.replace(/[\s)\]*_`'"]+$/, '');
  return trimmed.endsWith('?');
}

export async function listSessions() {
  await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  const entries = await readdir(LOG_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    try {
      const meta = JSON.parse(await readFile(`${LOG_DIR}/${entry.name}/meta.json`, 'utf8'));
      const count = meta.messageCount || 0;
      if (count === 0) continue;
      out.push({
        id: meta.id,
        title: meta.title || '',
        state: meta.state || 'in_progress',
        createdAt: meta.createdAt,
        lastMessageAt: meta.lastMessageAt,
        messageCount: count,
        rateLimitResetsAt: meta.rateLimitResetsAt ?? null,
      });
    } catch {}
  }
  out.sort((a, b) =>
    (b.lastMessageAt || b.createdAt || '').localeCompare(a.lastMessageAt || a.createdAt || '')
  );
  return out;
}

export async function getSession(id) {
  if (!UUID_RE.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(`${LOG_DIR}/${id}/meta.json`, 'utf8'));
    const messages = await readMessages(id);
    return { meta, messages };
  } catch {
    return null;
  }
}

export async function deleteSession(id) {
  if (!UUID_RE.test(id)) return false;
  try {
    await rm(`${LOG_DIR}/${id}`, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function patchSession(id, patch) {
  if (!UUID_RE.test(id)) return null;
  try {
    const path = `${LOG_DIR}/${id}/meta.json`;
    const meta = JSON.parse(await readFile(path, 'utf8'));
    applyMetaPatch(meta, patch);
    await writeFile(path, JSON.stringify(meta, null, 2));
    return meta;
  } catch {
    return null;
  }
}
