import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { WebSocketServer } from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8080;
const CWD = '/app';
const CLAUDE_HOME = '/home/developer';
const ORCHESTRATOR_MD = `${CLAUDE_HOME}/.claude/agents/chat-orchestrator.md`;
const LOG_DIR = '/chat-service/logs';
const WELCOME_CHOICES = {
  type: 'choices',
  content: 'Hello! How can I help you today?',
  options: [
    { id: 'FULL_SETUP', label: '🗺️  Set up my CRM from scratch', sublabel: 'Interview to understand your business and build a complete plan' },
    { id: 'QUICK_EDIT', label: '⚡ Make a quick change',          sublabel: 'Describe what you want to add or modify' },
  ],
};

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

// Static file server
const httpServer = createServer(async (req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
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

async function createSessionLog() {
  await mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${LOG_DIR}/session-${ts}.jsonl`;
  const stream = createWriteStream(path, { flags: 'a' });
  return {
    path,
    write: (dir, data) => stream.write(JSON.stringify({ ts: new Date().toISOString(), dir, ...data }) + '\n'),
    close: () => stream.end(),
  };
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
  const state = connections.get(ws);
  state?.log?.write('out', payload);
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

async function processMessage(ws, prompt) {
  const state = connections.get(ws);
  if (!state) return;

  safeSend(ws, { type: 'status', working: true });
  const toolMap = new Map();
  let receivedText = false;
  let rateLimit = null;
  let resultError = false;
  try {
    const proc = spawnClaude(prompt, state.sessionId);
    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      console.error('[claude]', d.toString().trim());
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.session_id) state.sessionId = event.session_id;

        // Always send raw event to debug
        safeSend(ws, { type: 'debug_raw', event });

        const text = extractText(event);
        if (text) {
          receivedText = true;
          safeSend(ws, { type: 'message', role: 'assistant', content: text });
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
    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    if (exitCode !== 0 || !receivedText || resultError || rateLimit) {
      safeSend(ws, {
        type: 'message',
        role: 'assistant',
        content: friendlyError({ exitCode, stderr: stderrBuf, rateLimit, resultError }),
      });
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      safeSend(ws, {
        type: 'message',
        role: 'assistant',
        content: "Something went wrong. Want to try again?",
      });
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
    }
  }
}

// Per-connection state: each browser tab gets its own claude session
const connections = new Map();

const wss = new WebSocketServer({ server: httpServer });
wss.on('error', (err) => console.error('WebSocket server error:', err));
httpServer.on('error', (err) => console.error('HTTP server error:', err));

wss.on('connection', async (ws) => {
  const log = await createSessionLog().catch(() => null);
  connections.set(ws, {
    sessionId: null,
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
    log,
  });
  if (log) console.log(`Session log: ${log.path}`);
  safeSend(ws, WELCOME_CHOICES);

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (!parsed.content?.trim()) return;

    const state = connections.get(ws);
    if (!state) return;
    state.log?.write('in', { type: 'user_message', content: parsed.content });
    if (state.busy) {
      state.queue.push(parsed.content);
    } else {
      state.busy = true;
      processMessage(ws, parsed.content);
    }
  });

  ws.on('close', () => {
    const s = connections.get(ws);
    s?.log?.close();
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
