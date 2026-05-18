import { readFile, appendFile, stat, mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, LOG_DIR, ALLOWED_STATES, MIME_TYPES, UUID_RE } from './config.js';
import { listSessions, getSession, patchSession, deleteSession } from './session-store.js';
import { runtimes } from './runtime.js';
import { broadcast, sendToWs } from './ws-bus.js';

const execFileAsync = promisify(execFile);
const GIT_BUF = { maxBuffer: 4 * 1024 * 1024 };
const COMMIT_FORMAT = '%H%x09%P%x09%s%x09%aI';
const parseCommitLog = (out) => out.split('\n').filter(Boolean).map((line) => {
  const [sha, parents, subject, date] = line.split('\t');
  return { sha, parents: parents ? parents.split(' ') : [], subject, date };
});

async function persistAssistantMessage(sessionId, content, { subtype } = {}) {
  const payload = { type: 'message', role: 'assistant', content, ts: new Date().toISOString() };
  if (subtype) payload.subtype = subtype;
  // Live runtime path — broadcast() handles WS fan-out + logWrite, so every
  // tab connected to this session sees the message immediately.
  const runtime = runtimes.get(sessionId);
  if (runtime?.session) {
    broadcast(runtime, payload);
    await runtime.session.recordMessage('assistant', content);
    return;
  }
  // No active runtime — append directly. Skip if the log doesn't exist
  // (don't materialise a stray session folder for an invalid id).
  const logPath = `${LOG_DIR}/${sessionId}/log.jsonl`;
  try { await stat(logPath); } catch { return; }
  const entry = { ts: new Date().toISOString(), dir: 'out', ...payload };
  await appendFile(logPath, JSON.stringify(entry) + '\n');
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

async function findRevertedFullShas() {
  // `git revert` writes a commit with body `This reverts commit <full sha>.`.
  // Scanning all reachable commits for that marker tells us which originals
  // have already been undone — so a second rollback on the same session can
  // see "nothing left to roll back" instead of re-reverting.
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '--all', '--grep=This reverts commit', '--format=%B%x00'],
      GIT_BUF,
    );
    const reverted = new Set();
    const re = /This reverts commit ([0-9a-f]{40})/g;
    let m;
    while ((m = re.exec(stdout)) !== null) reverted.add(m[1]);
    return reverted;
  } catch (err) {
    console.warn('[rollback] findRevertedFullShas failed:', err.message);
    return new Set();
  }
}

async function collectSessionCommitShas(sessionDir) {
  // Both flows have the merger report `commit=<short sha>` in its final
  // output (SIMPLE: `DONE: commit=<sha>...`; COMPLEX: SendMessage to team-lead
  // `merged TASK-XXX, commit=<sha>`). Reading those SHAs from log.jsonl is
  // the canonical session→commit linkage — more reliable than grepping commit
  // messages, since SIMPLE merges use a custom subject without the branch slug.
  try {
    const logText = await readFile(`${sessionDir}/log.jsonl`, 'utf8');
    const shas = new Set();
    const re = /commit=([a-f0-9]{7,40})/gi;
    let m;
    while ((m = re.exec(logText)) !== null) shas.add(m[1].toLowerCase());
    return [...shas];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Resolves the session's reported SHAs to full commit metadata, drops any
// already-reverted ones. Sorted newest-first. Used by both /commits and
// /rollback so the two routes stay in sync on what counts as "active".
async function loadActiveSessionCommits(sessionDir) {
  const reportedShas = await collectSessionCommitShas(sessionDir);
  if (reportedShas.length === 0) return [];
  const [resolveOut, reverted] = await Promise.all([
    execFileAsync('git', ['-C', CWD, 'log', '--no-walk', `--format=${COMMIT_FORMAT}`, ...reportedShas], GIT_BUF),
    findRevertedFullShas(),
  ]);
  return parseCommitLog(resolveOut.stdout)
    .filter((c) => !reverted.has(c.sha))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

async function handleSessionCommitsRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const primary = await loadActiveSessionCommits(`${LOG_DIR}/${sessionId}`);
    if (primary.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId, commits: [] }));
      return;
    }
    // Each merge commit hides its branch's source commits behind the merge.
    // Expand <merge>^1..<merge>^2 to surface the `simple: ...` /
    // `feat(TASK-XXX): ...` commits introduced by the branch — in parallel.
    const merges = primary.filter((c) => c.parents.length >= 2);
    const expansions = await Promise.all(merges.map(async (c) => {
      const range = `${c.parents[0]}..${c.parents[1]}`;
      try {
        const { stdout } = await execFileAsync('git', ['-C', CWD, 'log', range, `--format=${COMMIT_FORMAT}`], GIT_BUF);
        return parseCommitLog(stdout);
      } catch (err) {
        console.warn(`[commits] expand range ${range} failed:`, err.message);
        return [];
      }
    }));
    const seen = new Set(primary.map((c) => c.sha));
    const commits = [...primary];
    for (const list of expansions) {
      for (const child of list) {
        if (seen.has(child.sha)) continue;
        seen.add(child.sha);
        commits.push(child);
      }
    }
    commits.sort((a, b) => (a.date < b.date ? 1 : -1));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId, commits }));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_not_found' }));
      return;
    }
    console.error('handleSessionCommitsRequest failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'commits_lookup_failed', message: err.message }));
  }
}

async function captureConflictsAndAbort() {
  let conflicts = [];
  try {
    const { stdout } = await execFileAsync('git', ['-C', CWD, 'status', '--porcelain']);
    conflicts = stdout
      .split('\n')
      .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
      .map((l) => l.slice(3));
  } catch (err) {
    console.warn('[rollback] status check failed:', err.message);
  }
  try { await execFileAsync('git', ['-C', CWD, 'revert', '--abort']); }
  catch (err) { console.warn('[rollback] revert --abort failed:', err.message); }
  return conflicts;
}

async function handleSessionRollbackRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const commits = await loadActiveSessionCommits(`${LOG_DIR}/${sessionId}`);
    if (commits.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no_commits' }));
      return;
    }

    const reverted = [];
    for (const c of commits) {
      const args = ['-C', CWD, 'revert', '--no-edit'];
      if (c.parents.length >= 2) args.push('-m', '1');
      args.push(c.sha);
      try {
        await execFileAsync('git', args, GIT_BUF);
        reverted.push(c.sha);
      } catch (err) {
        const conflicts = await captureConflictsAndAbort();
        const filesLine = conflicts.length ? `\nConflicting files:\n- ${conflicts.join('\n- ')}` : '';
        const partial = reverted.length ? `\n${reverted.length} commit(s) were reverted before the conflict.` : '';
        const chatMessage = `Rollback stopped — conflict on ${c.sha.slice(0, 7)}.${filesLine}${partial}`;
        await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
          .catch((e) => console.warn('[rollback] persist failed:', e.message));
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'revert_conflict',
          failedAt: c.sha,
          reverted,
          conflicts,
          chatMessage,
          message: (err.stderr || err.message || '').toString(),
        }));
        return;
      }
    }
    const chatMessage = `Rollback done — ${reverted.length} commit${reverted.length > 1 ? 's' : ''} reverted.`;
    await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
      .catch((e) => console.warn('[rollback] persist failed:', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reverted, chatMessage }));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session_not_found' }));
      return;
    }
    console.error('handleSessionRollbackRequest failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'rollback_failed', message: err.message }));
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
