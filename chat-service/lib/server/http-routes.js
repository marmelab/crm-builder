import { readFile, appendFile, stat, mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { createReadStream, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, LOG_DIR, ALLOWED_STATES, MIME_TYPES, UUID_RE, MODE_DEMO, MODE_FULL, VALID_MODES } from './config.js';
import { listSessions, getSession, patchSession, deleteSession } from './session-store.js';
import { runtimes } from './runtime.js';
import { handleSessionCommitsRequest, handleSessionRollbackRequest, handleRecordCommit } from './rollback.js';
import { broadcast, sendToWs } from './ws-bus.js';

const execFileAsync = promisify(execFile);

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

async function handleStatsRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId || !UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing_or_invalid_sessionId' }));
    return;
  }
  const logPath = `${LOG_DIR}/${sessionId}/log.jsonl`;
  const hooksLogPath = `${LOG_DIR}/${sessionId}/hooks.log`;
  try {
    const { aggregateSession } = await import('../stats.js');
    const out = await aggregateSession({ sessionLogPath: logPath, hooksLogPath, sessionId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_log_not_found' }));
      return;
    }
    console.error('aggregateSession failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'aggregate_failed', message: err.message }));
  }
}


const ZIP_README = readFileSync(new URL('./download-readme.md', import.meta.url), 'utf8');
const CREATE_ZIP_PY = new URL('./create-zip.py', import.meta.url).pathname;

function tarCopy(src, dest, excludes = []) {
  return new Promise((resolve, reject) => {
    const create = spawn('tar', [...excludes.map((e) => `--exclude=${e}`), '-C', src, '-cf', '-', '.']);
    const extract = spawn('tar', ['-C', dest, '-xf', '-']);
    create.stdout.pipe(extract.stdin);
    create.stderr.on('data', (d) => console.error('[tar]', d.toString().trim()));
    extract.stderr.on('data', (d) => console.error('[tar]', d.toString().trim()));
    extract.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`tar extract exited ${code}`)); });
    create.on('error', reject);
    extract.on('error', reject);
  });
}

async function handleDownloadZipRequest(req, res) {
  const date = new Date().toISOString().slice(0, 10);
  const tmp = await mkdtemp(join(tmpdir(), 'crm-export-'));
  const contentDir = join(tmp, 'content');
  const zipPath = join(tmp, 'archive.zip');
  try {
    await mkdir(contentDir);

    await mkdir(join(contentDir, 'sources'));
    await tarCopy(CWD, join(contentDir, 'sources'), ['./node_modules', './worktrees', './dist', './.claude']);
    await writeFile(join(contentDir, 'README.md'), ZIP_README);

    try {
      await cp(LOG_DIR, join(contentDir, 'sessions'), { recursive: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    try {
      await cp('/home/developer/.claude/local', join(contentDir, 'documentator'), { recursive: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await execFileAsync('python3', [CREATE_ZIP_PY, contentDir, zipPath]);

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="crm-${date}.zip"`,
    });
    const stream = createReadStream(zipPath);
    stream.pipe(res);
    stream.on('close', () => rm(tmp, { recursive: true, force: true }).catch(() => {}));
    stream.on('error', (err) => {
      console.error('[download-zip] stream error:', err);
      rm(tmp, { recursive: true, force: true }).catch(() => {});
    });
  } catch (err) {
    console.error('[download-zip] error:', err);
    rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) { res.writeHead(500); res.end('zip failed'); }
  }
}


async function checkSupabaseReady() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 800);
    await fetch('http://localhost:54321', { signal: ctrl.signal });
    clearTimeout(tid);
    return true;
  } catch {
    return false;
  }
}

async function handleGetMode(req, res) {
  const mode = process.env.MODE || MODE_DEMO;
  const supabaseReady = await checkSupabaseReady();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ mode, supabaseReady }));
}

// Shared mode-switch helper: updates process.env.MODE, swaps App.tsx for the
// matching variant (sync, so the iframe reload sees the right file), and
// starts Supabase in the background when switching to full. Callers:
//   - POST /api/mode (the chat-UI mode toggle button)
//   - server.js, when a brand-new chat session opens while MODE=full
//     (auto-reset to demo).
// Returns true on success, false if the input mode is invalid.
export function switchMode(mode) {
  if (!VALID_MODES.has(mode)) return false;
  process.env.MODE = mode;
  const variant = mode === MODE_FULL ? 'App.supabase.tsx' : 'App.fakerest.tsx';
  try { copyFileSync(`/app-variants/${variant}`, '/app/src/App.tsx'); }
  catch (e) { console.warn('[mode-switch] App.tsx copy failed:', e.message); }
  if (mode === MODE_FULL) {
    const child = spawn('/usr/local/bin/switch-mode', [MODE_FULL], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, APP_DIR: '/app' },
    });
    child.unref();
  }
  return true;
}

// Broadcast a mode change to every connected WebSocket client (all sessions).
// Does NOT log to session — this is a global UI signal, not a session message.
function broadcastModeChange(mode, supabaseReady = false) {
  for (const runtime of runtimes.values()) {
    for (const client of runtime.clients) {
      sendToWs(client, { type: 'mode_changed', mode, supabaseReady });
    }
  }
}

async function handleSetMode(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const { mode } = body;
  if (!switchMode(mode)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mode must be demo or full' }));
    return;
  }
  // Notify other tabs that the mode changed. supabaseReady=false because
  // switch-mode.sh may still be starting Supabase in the background; those
  // clients will poll until it becomes ready.
  broadcastModeChange(mode, false);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, mode }));
}

// Called by switch-mode.sh at the end of its run (after Supabase is confirmed
// ready). Updates process.env.MODE and broadcasts with accurate supabaseReady
// so clients reload the iframe exactly once, when everything is actually up.
async function handleModeNotify(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const { mode } = body;
  if (!VALID_MODES.has(mode)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `mode must be ${MODE_DEMO} or ${MODE_FULL}` }));
    return;
  }
  process.env.MODE = mode;
  const supabaseReady = mode === MODE_FULL ? await checkSupabaseReady() : false;
  broadcastModeChange(mode, supabaseReady);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

export function createRequestHandler({ publicDir }) {
  return async (req, res) => {
    if (req.url === '/api/mode' && req.method === 'GET') return handleGetMode(req, res);
    if (req.url === '/api/mode' && req.method === 'POST') return handleSetMode(req, res);
    if (req.url === '/api/mode/notify' && req.method === 'POST') return handleModeNotify(req, res);

    if (req.url === '/api/download/zip' && req.method === 'GET') {
      return handleDownloadZipRequest(req, res);
    }
    if (req.url?.startsWith('/api/stats')) return handleStatsRequest(req, res);

    const commitsMatch = req.url?.match(/^\/api\/sessions\/([0-9a-f-]+)\/commits$/i);
    if (commitsMatch && req.method === 'GET') {
      return handleSessionCommitsRequest(req, res, commitsMatch[1]);
    }
    const recordCommitMatch = req.url?.match(/^\/api\/sessions\/([0-9a-f-]+)\/commits\/([0-9a-f]{7,40})$/i);
    if (recordCommitMatch && req.method === 'POST') {
      return handleRecordCommit(req, res, recordCommitMatch[1], recordCommitMatch[2]);
    }
    const rollbackMatch = req.url?.match(/^\/api\/sessions\/([0-9a-f-]+)\/rollback$/i);
    if (rollbackMatch && req.method === 'POST') {
      return handleSessionRollbackRequest(req, res, rollbackMatch[1]);
    }

    // API: list sessions
    if (req.url === '/api/sessions' && req.method === 'GET') {
      const list = await listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    // API: get / rename one session
    const match = req.url.match(/^\/api\/sessions\/([0-9a-f-]+)$/i);
    if (match) {
      const id = match[1];
      if (req.method === 'GET') {
        const d = await getSession(id);
        if (!d) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(d));
        return;
      }
      if (req.method === 'DELETE') {
        if (!UUID_RE.test(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_sessionId' }));
          return;
        }
        const runtime = runtimes.get(id);
        if (runtime?.busy) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'session_busy' }));
          return;
        }
        if (runtime) {
          // Notify clients without going through broadcast() — broadcast logs
          // the event to the session log, which we're about to delete.
          for (const client of runtime.clients) {
            sendToWs(client, { type: 'session_deleted', sessionId: id });
            try { client.close(); } catch {}
          }
          // Await the log stream's flush before rm — close() resolves once
          // logStream.end() drains, so we don't race writes against deletion.
          try { await runtime.session?.close(); } catch {}
          runtimes.delete(id);
        }
        await deleteSession(id);
        res.writeHead(204);
        res.end();
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
          // If a runtime is active for this session, apply the patch through it
          // so its in-memory meta stays in sync; otherwise fall back to the
          // disk-only patcher.
          const runtime = runtimes.get(id);
          const meta = runtime?.session
            ? await runtime.session.applyPatch(body)
            : await patchSession(id, body);
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
  };
}
