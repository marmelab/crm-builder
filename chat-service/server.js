import { createServer } from 'http';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const CWD = '/app';
const CLAUDE_HOME = '/home/developer';
const ORCHESTRATOR_MD = `${CLAUDE_HOME}/.claude/agents/chat-orchestrator.md`;
const LOG_DIR = process.env.CHAT_LOG_DIR || '/chat-service/logs';
const WELCOME_CHOICES = {
  type: 'choices',
  content: 'Hello! How can I help you today?',
  options: [
    { id: 'FULL_SETUP', label: '🗺️  Set up my CRM from scratch', sublabel: 'Interview to understand your business and build a complete plan' },
    { id: 'QUICK_EDIT', label: '⚡ Make a quick change',          sublabel: 'Describe what you want to add or modify' },
  ],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadSystemPrompt() {
  try {
    const raw = await readFile(ORCHESTRATOR_MD, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const model = fm?.[1].match(/^model:\s*(\S+)/m)?.[1] || null;
    const toolsBlock = fm?.[1].match(/^tools:\n((?:[ \t]+-\s+\S+\n?)+)/m)?.[1];
    const tools = toolsBlock
      ? toolsBlock.split('\n').map((l) => l.replace(/^[ \t]+-\s+/, '').trim()).filter(Boolean)
      : null;
    const content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    return { content, model, tools };
  } catch {
    return { content: '', model: null, tools: null };
  }
}

let systemPrompt = '';
let orchestratorModel = null;
let orchestratorTools = null;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
};

// Exported for unit testing
export function extractText(msg) {
  if (msg.type !== 'assistant') return null;
  const text = msg.message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text.trim() ? text : null;
}

export function extractToolUses(msg) {
  if (msg.type !== 'assistant') return [];
  return msg.message.content.filter((b) => b.type === 'tool_use');
}

// ─── Discussion persistence ───────────────────────────────────
// Single source of truth = log.jsonl (append-only stream of ws in/out events).
// meta.json holds only lightweight metadata (title, timestamps, counts,
// claudeSessionId) so the listing page doesn't have to parse every log.
// Visible messages (user + assistant) are derived from log.jsonl on demand.

function messagesFromLog(logText) {
  const out = [];
  for (const line of logText.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.dir === 'in' && entry.type === 'user_message') {
      out.push({ role: 'user', content: entry.display || entry.content || '', ts: entry.ts });
    } else if (entry.dir === 'out' && entry.type === 'message' && entry.role === 'assistant') {
      out.push({ role: 'assistant', content: entry.content || '', ts: entry.ts });
    }
  }
  return out;
}

async function readMessages(id) {
  try {
    const raw = await readFile(`${LOG_DIR}/${id}/log.jsonl`, 'utf8');
    return messagesFromLog(raw);
  } catch {
    return [];
  }
}

async function openDiscussion(requestedId) {
  await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  let id = requestedId && UUID_RE.test(requestedId) ? requestedId : null;
  let meta = null;
  let isNew = false;
  let messages = [];

  if (id) {
    try {
      meta = JSON.parse(await readFile(`${LOG_DIR}/${id}/meta.json`, 'utf8'));
      messages = await readMessages(id);
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
      state: 'en_cours',
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
    logWrite: (dir, data) =>
      logStream.write(JSON.stringify({ ts: new Date().toISOString(), dir, ...data }) + '\n'),
    // Record that a visible message has just been appended to the log (meta side effects only).
    recordMessage: async (role, content) => {
      meta.lastMessageAt = new Date().toISOString();
      meta.messageCount = (meta.messageCount || 0) + 1;
      if (role === 'user') {
        meta.userMessageCount = (meta.userMessageCount || 0) + 1;
        if (!meta.title) meta.title = content.trim().replace(/\s+/g, ' ').slice(0, 60);
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
      await saveMeta();
      return true;
    },
    close: () => logStream.end(),
  };
}

const ALLOWED_STATES = new Set(['en_cours', 'terminee']);

async function listDiscussions() {
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
        state: meta.state || 'en_cours',
        createdAt: meta.createdAt,
        lastMessageAt: meta.lastMessageAt,
        messageCount: count,
      });
    } catch {}
  }
  out.sort((a, b) =>
    (b.lastMessageAt || b.createdAt || '').localeCompare(a.lastMessageAt || a.createdAt || '')
  );
  return out;
}

async function getDiscussion(id) {
  if (!UUID_RE.test(id)) return null;
  try {
    const meta = JSON.parse(await readFile(`${LOG_DIR}/${id}/meta.json`, 'utf8'));
    const messages = await readMessages(id);
    return { meta, messages };
  } catch {
    return null;
  }
}

async function patchDiscussion(id, patch) {
  if (!UUID_RE.test(id)) return null;
  try {
    const path = `${LOG_DIR}/${id}/meta.json`;
    const meta = JSON.parse(await readFile(path, 'utf8'));
    if (typeof patch.title === 'string') {
      meta.title = patch.title.slice(0, 200);
      meta.titleLocked = true; // manual rename wins over future auto-regens
    }
    if (typeof patch.state === 'string' && ALLOWED_STATES.has(patch.state)) meta.state = patch.state;
    await writeFile(path, JSON.stringify(meta, null, 2));
    return meta;
  } catch {
    return null;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 100_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── HTTP server ──────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  // API: list discussions
  if (req.url === '/api/discussions' && req.method === 'GET') {
    const list = await listDiscussions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }
  // API: get / rename one discussion
  const match = req.url.match(/^\/api\/discussions\/([0-9a-f-]+)$/i);
  if (match) {
    const id = match[1];
    if (req.method === 'GET') {
      const d = await getDiscussion(id);
      if (!d) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
      return;
    }
    if (req.method === 'PATCH') {
      try {
        const body = await readJsonBody(req);
        const hasTitle = typeof body.title === 'string';
        const hasState = typeof body.state === 'string';
        if (!hasTitle && !hasState) {
          res.writeHead(400); res.end('title or state required'); return;
        }
        if (hasState && !ALLOWED_STATES.has(body.state)) {
          res.writeHead(400); res.end(`state must be one of: ${[...ALLOWED_STATES].join(', ')}`); return;
        }
        const meta = await patchDiscussion(id, body);
        if (!meta) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
      } catch {
        res.writeHead(400); res.end('Bad request');
      }
      return;
    }
  }

  // Static file server
  const pathOnly = (req.url || '/').split('?')[0];
  const urlPath = pathOnly === '/' ? '/index.html' : pathOnly;
  const publicDir = join(__dirname, 'public');
  const filePath = join(publicDir, urlPath);
  if (!filePath.startsWith(publicDir + '/')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  try {
    const data = await readFile(filePath);
    const mime = MIME_TYPES[extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

function spawnClaude(userMessage, sessionId) {
  const mode = process.env.MODE || 'demo';
  const prompt = systemPrompt
    ? `<instructions>\n${systemPrompt}\n</instructions>\n\n<mode>${mode}</mode>\n\n${userMessage}`
    : userMessage;
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (orchestratorModel) args.push('--model', orchestratorModel);
  if (sessionId) args.push('--resume', sessionId);
  args.push('-p', prompt);
  return spawn('claude', args, {
    env: {
      ...process.env,
      HOME: CLAUDE_HOME,
      CLAUDE_PROJECT_DIR: CWD,
      MODE: mode,
    },
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Runs a one-shot Haiku call to regenerate the discussion title. Invoked when
// the user sends their 2nd message so the label reflects what the chat is
// actually about (the first auto-title is a crude first-message slice).
async function regenerateTitleWithHaiku(ws, discussion) {
  if (!discussion) return;
  const m = discussion.meta;
  if (m.titleLocked || m.titleAutoGenerated) return;

  const msgs = await readMessages(discussion.id);
  if (msgs.length < 2) return;

  // Send the first few exchanges — more than that dilutes the signal.
  const convo = msgs.slice(0, 6)
    .map((x) => `${x.role === 'user' ? 'User' : 'Assistant'}: ${x.content}`)
    .join('\n\n');
  const prompt =
    `Based on the conversation below, generate a concise title (3 to 6 words, ` +
    `same language as the user, no punctuation, no quotes, no emoji). ` +
    `Reply with ONLY the title, nothing else.\n\n${convo}`;

  const proc = spawn('claude', [
    '--model', 'claude-haiku-4-5',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ], {
    env: { ...process.env, HOME: CLAUDE_HOME },
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.once('error', () => {}); // Don't crash if claude isn't on PATH.

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const exitCode = await new Promise((resolve) => proc.once('close', resolve))
    .catch(() => -1);
  if (exitCode !== 0) {
    if (err) console.error('[haiku-title]', err.trim());
    return;
  }

  const title = out.trim().split('\n')[0]
    .replace(/^["'`«]+|["'`»]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
  if (!title) return;

  // Re-check the flag — the user could have renamed while Haiku was running.
  if (discussion.meta.titleLocked) return;
  await discussion.setTitle(title, { auto: true });
  safeSend(ws, { type: 'title', title });
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
  const state = connections.get(ws);
  state?.discussion?.logWrite('out', payload);
}

function sendStats(ws) {
  const state = connections.get(ws);
  if (!state) return;
  safeSend(ws, {
    type: 'stats',
    tokensUsed: state.stats.tokensUsed,
    costUsd: state.stats.costUsd + state.stats.costUsdCurrentSpawn,
    activeAgents: state.stats.activeAgents,
  });
}

function friendlyError({ exitCode, stderr, rateLimit, resultError }) {
  if (rateLimit?.resetsAt) {
    const minutes = Math.max(1, Math.ceil((rateLimit.resetsAt * 1000 - Date.now()) / 60000));
    return `Usage limit reached. You can try again in about ${minutes} minute(s).`;
  }
  if (/invalid[_ ]api[_ ]key|authentication|unauthori[sz]ed|401/i.test(stderr)) {
    return "Access has expired. Please contact your administrator to renew the session.";
  }
  if (/network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(stderr)) {
    return "Unable to reach the service right now. Check your connection and try again.";
  }
  if (resultError) {
    return "Something went wrong while processing your request. Want to try again?";
  }
  if (exitCode !== 0) {
    return "An unexpected error occurred. Want to try again?";
  }
  return "I couldn't complete your request. Could you rephrase it?";
}

async function transitionState(ws, newState) {
  const s = connections.get(ws);
  if (!s?.discussion) return;
  const changed = await s.discussion.setState(newState).catch(() => false);
  if (changed) safeSend(ws, { type: 'state', state: newState });
}

async function processMessage(ws, prompt) {
  const state = connections.get(ws);
  if (!state) return;

  // Claude (re)starts → discussion is active again.
  transitionState(ws, 'en_cours');
  safeSend(ws, { type: 'status', working: true });
  const toolMap = new Map();
  let receivedText = false;
  let rateLimit = null;
  let resultError = false;
  try {
    const proc = spawnClaude(prompt, state.sessionId);
    let stderrBuf = '';
    // Prevent unhandled 'error' from crashing the process (e.g. claude binary missing).
    const spawnError = new Promise((resolve) => proc.once('error', resolve));
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      console.error('[claude]', d.toString().trim());
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.session_id) {
          state.sessionId = event.session_id;
          state.discussion?.setClaudeSessionId(event.session_id).catch(() => {});
        }

        // Always send raw event to debug
        safeSend(ws, { type: 'debug_raw', event });

        const text = extractText(event);
        if (text) {
          receivedText = true;
          safeSend(ws, { type: 'message', role: 'assistant', content: text });
          state.discussion?.recordMessage('assistant', text).catch(() => {});
        }

        for (const tool of extractToolUses(event)) {
          toolMap.set(tool.id, tool);
        }

        if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'blocked') {
          rateLimit = event.rate_limit_info;
        }

        // Track active sub-agents (task_started / task_completed / task_notification)
        if (event.type === 'system') {
          if (event.subtype === 'task_started') {
            state.stats.activeAgents++;
            sendStats(ws);
          } else if (event.subtype === 'task_notification' && event.status === 'completed') {
            state.stats.activeAgents = Math.max(0, state.stats.activeAgents - 1);
            sendStats(ws);
          }
        }

        if (event.type === 'result') {
          if (event.is_error) resultError = true;
          const u = event.usage || {};
          // tokens: usage is per-turn, sum is correct. Exclude cache_read — it's
          // re-hydrated cached context, facturé 10× moins et pas "consommé"
          // depuis la limite utilisateur.
          state.stats.tokensUsed +=
            (u.input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.output_tokens || 0);
          // cost: total_cost_usd is cumulative within the current spawn — replace,
          // don't add (summing cumulative values inflates massively).
          state.stats.costUsdCurrentSpawn = event.total_cost_usd || 0;
          // Reset active agents when turn ends (safety — sub-agents should all be done)
          state.stats.activeAgents = 0;
          sendStats(ws);
        }
      } catch {}
    }
    const exitCode = await Promise.race([
      new Promise((resolve) => proc.on('close', resolve)),
      spawnError.then((err) => {
        stderrBuf += `\n${err?.message || err}`;
        return -1;
      }),
    ]);
    if (exitCode !== 0 || !receivedText || resultError || rateLimit) {
      const errText = friendlyError({ exitCode, stderr: stderrBuf, rateLimit, resultError });
      safeSend(ws, { type: 'message', role: 'assistant', content: errText });
      state.discussion?.recordMessage('assistant', errText).catch(() => {});
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      const errText = "Something went wrong. Want to try again?";
      safeSend(ws, { type: 'message', role: 'assistant', content: errText });
      state.discussion?.recordMessage('assistant', errText).catch(() => {});
    }
  } finally {
    // Commit this spawn's cumulative cost into the session total, reset for next spawn
    const s0 = connections.get(ws);
    if (s0) {
      s0.stats.costUsd += s0.stats.costUsdCurrentSpawn;
      s0.stats.costUsdCurrentSpawn = 0;
      sendStats(ws);
    }

    safeSend(ws, { type: 'status', working: false });
    const s = connections.get(ws);
    if (s && s.queue.length > 0) {
      const next = s.queue.shift();
      processMessage(ws, next);
    } else if (s) {
      s.busy = false;
      // All queued turns processed and claude is idle → discussion is done
      // (until the user sends another message).
      transitionState(ws, 'terminee');
    }
  }
}

// Per-connection state: each browser tab gets its own claude session
const connections = new Map();

const wss = new WebSocketServer({ server: httpServer });
wss.on('error', (err) => console.error('WebSocket server error:', err));
httpServer.on('error', (err) => console.error('HTTP server error:', err));

wss.on('connection', async (ws, req) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestedId = urlObj.searchParams.get('discussion');
  const discussion = await openDiscussion(requestedId).catch(() => null);
  if (!discussion) {
    ws.close();
    return;
  }

  connections.set(ws, {
    sessionId: discussion.meta.claudeSessionId || null,
    discussion,
    busy: false,
    queue: [],
    stats: {
      // tokensUsed = fresh input + cache_creation + output (cache_read excluded:
      // it's re-hydrated cached context, not "burned" from the user's budget)
      tokensUsed: 0,
      // costUsd = committed cost from finished spawns
      costUsd: 0,
      // costUsdCurrentSpawn = cumulative total_cost_usd from the in-progress spawn
      // (Claude CLI emits this as cumulative-within-spawn, so we replace not add)
      costUsdCurrentSpawn: 0,
      activeAgents: 0,
    },
  });
  console.log(`Discussion ${discussion.isNew ? 'created' : 'resumed'}: ${discussion.id}`);

  safeSend(ws, {
    type: 'init',
    discussionId: discussion.id,
    title: discussion.meta.title,
    state: discussion.meta.state || 'en_cours',
    messages: discussion.messages,
    isNew: discussion.isNew,
  });
  if (discussion.isNew) {
    safeSend(ws, WELCOME_CHOICES);
  }

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (!parsed.content?.trim()) return;

    const state = connections.get(ws);
    if (!state) return;
    // `display` is an optional client-side label (e.g. for choice buttons) —
    // what the user actually saw. `content` is what we forward to claude.
    const displayed = typeof parsed.display === 'string' && parsed.display.trim()
      ? parsed.display
      : parsed.content;
    state.discussion.logWrite('in', { type: 'user_message', content: parsed.content, display: displayed });
    state.discussion.recordMessage('user', displayed).then(() => {
      // Trigger Haiku retitling on the 2nd user message, once per discussion.
      const m = state.discussion.meta;
      if (m.userMessageCount === 2 && !m.titleLocked && !m.titleAutoGenerated) {
        regenerateTitleWithHaiku(ws, state.discussion).catch(() => {});
      }
    }).catch(() => {});
    if (state.busy) {
      state.queue.push(parsed.content);
    } else {
      state.busy = true;
      processMessage(ws, parsed.content);
    }
  });

  ws.on('close', () => {
    const s = connections.get(ws);
    s?.discussion?.close();
    connections.delete(ws);
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadSystemPrompt().then(({ content, model, tools }) => {
    systemPrompt = content;
    orchestratorModel = model;
    orchestratorTools = tools;
    const t = tools?.length ? tools.join(',') : 'default';
    console.log(content ? `Orchestrator loaded (model: ${model || 'default'}, tools: ${t}).` : 'No orchestrator prompt, using default.');
  });
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Chat service listening on port ${PORT}`);
  });
}
