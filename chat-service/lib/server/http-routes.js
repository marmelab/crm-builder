import { readFile, mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, LOG_DIR, ALLOWED_STATES, MIME_TYPES, UUID_RE } from './config.js';
import { listSessions, getSession, patchSession } from './session-store.js';
import { runtimes } from './runtime.js';
import { handleSessionCommitsRequest, handleSessionRollbackRequest } from './rollback.js';

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


export function createRequestHandler({ publicDir }) {
  return async (req, res) => {
    if (req.url === '/api/download/zip' && req.method === 'GET') {
      return handleDownloadZipRequest(req, res);
    }
    if (req.url?.startsWith('/api/stats')) return handleStatsRequest(req, res);

    const commitsMatch = req.url?.match(/^\/api\/sessions\/([0-9a-f-]+)\/commits$/i);
    if (commitsMatch && req.method === 'GET') {
      return handleSessionCommitsRequest(req, res, commitsMatch[1]);
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
