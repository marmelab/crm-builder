import { readFile, appendFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, LOG_DIR, ALLOWED_STATES, MIME_TYPES, UUID_RE, DOCUMENTATOR_OPTS } from './config.js';
import { listSessions, getSession, patchSession } from './session-store.js';
import { runtimes } from './runtime.js';
import { runDocumentator } from '../documentator-cron.js';

const execFileAsync = promisify(execFile);

async function persistAssistantMessage(sessionId, content, { subtype } = {}) {
  // Live runtime path — keeps meta.json in sync (lastMessageAt, messageCount).
  const runtime = runtimes.get(sessionId);
  if (runtime?.session) {
    const payload = { type: 'message', role: 'assistant', content };
    if (subtype) payload.subtype = subtype;
    runtime.session.logWrite('out', payload);
    await runtime.session.recordMessage('assistant', content);
    return;
  }
  // No active runtime — append directly. Skip if the log doesn't exist
  // (don't materialise a stray session folder for an invalid id).
  const logPath = `${LOG_DIR}/${sessionId}/log.jsonl`;
  try { await stat(logPath); } catch { return; }
  const entry = {
    ts: new Date().toISOString(),
    dir: 'out',
    type: 'message',
    role: 'assistant',
    content,
  };
  if (subtype) entry.subtype = subtype;
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
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const reverted = new Set();
    const re = /This reverts commit ([0-9a-f]{40})/g;
    let m;
    while ((m = re.exec(stdout)) !== null) reverted.add(m[1]);
    return reverted;
  } catch {
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

async function handleSessionCommitsRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const sessionDir = `${LOG_DIR}/${sessionId}`;
    const reportedShas = await collectSessionCommitShas(sessionDir);
    if (reportedShas.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId, commits: [] }));
      return;
    }
    const FORMAT = '%H%x09%P%x09%s%x09%aI';
    const parseLog = (out) => out.split('\n').filter(Boolean).map((line) => {
      const [sha, parents, subject, date] = line.split('\t');
      return { sha, parents: parents ? parents.split(' ') : [], subject, date };
    });

    const { stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '--no-walk', `--format=${FORMAT}`, ...reportedShas],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const reverted = await findRevertedFullShas();
    const primary = parseLog(stdout).filter((c) => !reverted.has(c.sha));
    if (primary.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId, commits: [] }));
      return;
    }

    // Each merge commit hides its branch's source commits behind the merge.
    // Expand <merge>^1..<merge>^2 to surface the `simple: ...` /
    // `feat(TASK-XXX): ...` commits introduced by the branch.
    const seen = new Set(primary.map((c) => c.sha));
    const commits = [...primary];
    for (const c of primary) {
      if (c.parents.length < 2) continue;
      const range = `${c.parents[0]}..${c.parents[1]}`;
      try {
        const { stdout: s2 } = await execFileAsync(
          'git',
          ['-C', CWD, 'log', range, `--format=${FORMAT}`],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        for (const child of parseLog(s2)) {
          if (seen.has(child.sha)) continue;
          seen.add(child.sha);
          commits.push(child);
        }
      } catch (err) {
        console.warn(`[commits] expand range ${range} failed:`, err.message);
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

async function handleSessionRollbackRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const sessionDir = `${LOG_DIR}/${sessionId}`;
    const reportedShas = await collectSessionCommitShas(sessionDir);
    if (reportedShas.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no_commits' }));
      return;
    }
    // Resolve full SHAs and parents — `--no-walk` keeps the order of the
    // arguments, but we want newest-first so we sort by commit date.
    const { stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '--no-walk', '--format=%H%x09%P%x09%aI', ...reportedShas],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const alreadyReverted = await findRevertedFullShas();
    const commits = stdout.split('\n').filter(Boolean).map((line) => {
      const [sha, parents, date] = line.split('\t');
      return { sha, parents: parents ? parents.split(' ') : [], date };
    }).filter((c) => !alreadyReverted.has(c.sha));
    if (commits.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no_commits' }));
      return;
    }
    commits.sort((a, b) => (a.date < b.date ? 1 : -1));

    const reverted = [];
    for (const c of commits) {
      const args = ['-C', CWD, 'revert', '--no-edit'];
      if (c.parents.length >= 2) args.push('-m', '1');
      args.push(c.sha);
      try {
        await execFileAsync('git', args, { maxBuffer: 4 * 1024 * 1024 });
        reverted.push(c.sha);
      } catch (err) {
        // Capture conflicts BEFORE aborting (abort wipes the index state).
        let conflicts = [];
        try {
          const { stdout: st } = await execFileAsync('git', ['-C', CWD, 'status', '--porcelain']);
          conflicts = st
            .split('\n')
            .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
            .map((l) => l.slice(3));
        } catch {}
        try { await execFileAsync('git', ['-C', CWD, 'revert', '--abort']); } catch {}
        const filesLine = conflicts.length ? `\nConflicting files:\n- ${conflicts.join('\n- ')}` : '';
        const partial = reverted.length ? `\n${reverted.length} commit(s) were reverted before the conflict.` : '';
        const chatMessage = `Rollback stopped — conflict on ${c.sha.slice(0, 7)}.${filesLine}${partial}`;
        await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' }).catch(() => {});
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
    await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' }).catch(() => {});
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

export function createRequestHandler({ publicDir }) {
  return async (req, res) => {
    if (req.url?.startsWith('/api/stats')) return handleStatsRequest(req, res);

    const commitsMatch = req.url?.match(/^\/api\/sessions\/([0-9a-f-]+)\/commits$/i);
    if (commitsMatch && req.method === 'GET') {
      return handleSessionCommitsRequest(req, res, commitsMatch[1]);
    }
    const rollbackMatch = req.url?.match(/^\/api\/sessions\/([0-9a-f-]+)\/rollback$/i);
    if (rollbackMatch && req.method === 'POST') {
      return handleSessionRollbackRequest(req, res, rollbackMatch[1]);
    }

    // API: trigger a documentator run manually (loopback only — see config.js for opts).
    if (req.url === '/api/documentator/run' && req.method === 'POST') {
      const remote = req.socket.remoteAddress || '';
      const isLoopback =
        remote === '127.0.0.1' ||
        remote === '::1' ||
        remote === '::ffff:127.0.0.1';
      if (!isLoopback) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'documentator manual trigger restricted to loopback' }));
        return;
      }
      runDocumentator(DOCUMENTATOR_OPTS)
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
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
