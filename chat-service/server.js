import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8080;
const CWD = '/app';
const WELCOME = 'Hello, ready to build your dreaming CRM? Ask me in any language';

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

// Static file server
const httpServer = createServer(async (req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = join(__dirname, 'public', urlPath);
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

// Single SDK session shared across all browser connections
let session = null;
let busy = false;
const messageQueue = [];

function getSession() {
  if (!session) {
    session = unstable_v2_createSession({
      model: 'claude-opus-4-6',
      cwd: CWD,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  }
  return session;
}

function safeSend(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function processNext() {
  if (messageQueue.length === 0) {
    busy = false;
    return;
  }
  busy = true;
  const { ws, content } = messageQueue.shift();
  const s = getSession();

  safeSend(ws, { type: 'status', working: true });
  try {
    await s.send(content);
    for await (const msg of s.stream()) {
      const text = extractText(msg);
      if (text) safeSend(ws, { type: 'message', role: 'assistant', content: text });
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      safeSend(ws, {
        type: 'message',
        role: 'assistant',
        content: 'Something went wrong with this change. Want me to try a different approach?',
      });
    }
  } finally {
    safeSend(ws, { type: 'status', working: false });
    processNext();
  }
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  safeSend(ws, { type: 'message', role: 'assistant', content: WELCOME });

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (!parsed.content?.trim()) return;
    messageQueue.push({ ws, content: parsed.content });
    if (!busy) processNext();
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Chat service listening on port ${PORT}`);
});
