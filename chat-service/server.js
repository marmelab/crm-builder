import { createServer } from 'http';
import { readFile } from 'fs/promises';
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
    return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch {
    return '';
  }
}

let systemPrompt = '';

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
  const prompt = systemPrompt
    ? `<instructions>\n${systemPrompt}\n</instructions>\n\n${userMessage}`
    : userMessage;
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ];
  if (sessionId) args.push('--resume', sessionId);
  return spawn('claude', args, {
    env: { ...process.env, HOME: CLAUDE_HOME },
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function processMessage(ws, prompt) {
  const state = connections.get(ws);
  if (!state) return;

  safeSend(ws, { type: 'status', working: true });
  let receivedText = false;
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
        const text = extractText(event);
        if (text) { receivedText = true; safeSend(ws, { type: 'message', role: 'assistant', content: text }); }
        for (const tool of extractToolUses(event)) {
          safeSend(ws, { type: 'debug', tool: tool.name, input: tool.input });
        }
      } catch {}
    }
    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    if (exitCode !== 0 || !receivedText) {
      const hint = stderrBuf.includes('OAuth') ? ' (OAuth not supported — try ANTHROPIC_API_KEY)' : '';
      safeSend(ws, { type: 'message', role: 'assistant', content: `Something went wrong${hint}. Check container logs for details.` });
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      safeSend(ws, {
        type: 'message',
        role: 'assistant',
        content: 'Something went wrong with this change. Want me to try a different approach?',
      });
    }
  } finally {
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

wss.on('connection', (ws) => {
  connections.set(ws, { sessionId: null, busy: false, queue: [] });
  safeSend(ws, WELCOME_CHOICES);

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (!parsed.content?.trim()) return;

    const state = connections.get(ws);
    if (!state) return;
    if (state.busy) {
      state.queue.push(parsed.content);
    } else {
      state.busy = true;
      processMessage(ws, parsed.content);
    }
  });

  ws.on('close', () => connections.delete(ws));
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadSystemPrompt().then((sp) => {
    systemPrompt = sp;
    console.log(sp ? 'Orchestrator system prompt loaded.' : 'No orchestrator prompt found, using default.');
  });
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Chat service listening on port ${PORT}`);
  });
}
