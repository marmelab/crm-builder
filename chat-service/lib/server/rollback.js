import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, UUID_RE } from './config.js';
import { runtimes, createRuntime, setSessionState, persistAssistantMessage } from './runtime.js';
import { openSession } from './session-store.js';
import { processMessage } from './turn.js';

const execFileAsync = promisify(execFile);
const GIT_BUF = { maxBuffer: 4 * 1024 * 1024 };

// Serialises every operation that writes to /app's base branch. Two concurrent
// rollbacks on different sessions would otherwise race on `.git/index.lock`
// and produce interleaved revert commits; the merger of an active dev wave
// can still race with us (it lives in its own process), but `.git/index.lock`
// + the merger's retry-once handle that case.
let mainBranchMutex = Promise.resolve();
export async function withMainBranchLock(fn) {
  const previous = mainBranchMutex;
  let releaseNext;
  mainBranchMutex = new Promise((r) => { releaseNext = r; });
  try {
    await previous;
    return await fn();
  } finally {
    releaseNext();
  }
}

// `git revert` writes a commit with body `This reverts commit <full sha>.`.
// Scanning all reachable commits for that marker gives us a safety net on top
// of `meta.commits[].revertedAt`: if the optimistic mark was missed (crash,
// race), the next rollback still skips already-reverted SHAs.
const REVERT_PREFIX = 'This reverts commit ';
async function findRevertedFullShas() {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '--all', '--grep=This reverts commit', '--format=%B'],
      GIT_BUF,
    );
    const reverted = stdout
      .split('\n')
      .filter((line) => line.startsWith(REVERT_PREFIX))
      .map((line) => line.slice(REVERT_PREFIX.length).replace(/\.$/, ''));
    return new Set(reverted);
  } catch (err) {
    console.warn('[rollback] findRevertedFullShas failed:', err.message);
    return new Set();
  }
}

// Source of truth: meta.commits, appended by the merger via the
// /api/sessions/:id/commits/:sha endpoint after each successful merge. We
// filter out entries already marked revertedAt AND those whose SHA appears
// in some `This reverts commit ...` body anywhere in history.
async function listActiveSessionCommits(sessionId) {
  const session = runtimes.get(sessionId)?.session || await openSession(sessionId);
  if (!session) return { session: null, commits: [] };
  const all = session.meta.commits || [];
  if (all.length === 0) return { session, commits: [] };
  const reverted = await findRevertedFullShas();
  const commits = all
    .filter((c) => !c.revertedAt && !reverted.has(c.sha))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { session, commits };
}

export async function handleSessionCommitsRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const { commits } = await listActiveSessionCommits(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId, commits }));
  } catch (err) {
    console.error('handleSessionCommitsRequest failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'commits_lookup_failed', message: err.message }));
  }
}

// POST /api/sessions/:id/commits/:sha — called by the merger from inside its
// agent process right after a successful `git merge --no-ff`. We resolve the
// subject server-side from git (avoids the merger having to escape it) and
// append the entry to meta.commits via the session's applyPatch.
export async function handleRecordCommit(req, res, sessionId, sha) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sha' }));
    return;
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '-1', '--format=%H%x09%s', sha],
      GIT_BUF,
    );
    const [fullSha, subject] = stdout.trim().split('\t');
    const runtime = runtimes.get(sessionId);
    const session = runtime?.session || await openSession(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_not_found' }));
      return;
    }
    await session.applyPatch({ addCommit: { sha: fullSha, subject: subject || '' } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sha: fullSha }));
  } catch (err) {
    console.error('handleRecordCommit failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'record_commit_failed', message: err.message }));
  }
}

// Hand the conflict over to the chat-orchestrator: ensure a runtime exists,
// then enqueue/dispatch a synthetic user turn carrying the rollback intent
// and the list of commits still to revert. The orchestrator routes the
// `<intent>rollback-conflict</intent>` marker to its SIMPLE-flow variant which
// dispatches a single simple-developer + merger inside the standard SIMPLE
// worktree (created by the `setup-worktree` hook as usual).
async function handOffToOrchestrator(sessionId, { failedCommit, remaining }) {
  let runtime = runtimes.get(sessionId);
  if (!runtime) {
    const session = await openSession(sessionId).catch(() => null);
    if (!session) {
      console.warn('[rollback] cannot open session for handoff:', sessionId);
      return false;
    }
    runtime = createRuntime(session);
    runtimes.set(sessionId, runtime);
  }

  const list = remaining
    .map((c) => `  - ${c.sha}    # ${c.subject.replace(/[`"\\]/g, '')}`)
    .join('\n') || '  (none)';
  const failedShort = failedCommit.sha.slice(0, 7);
  const safeSubject = failedCommit.subject.replace(/[`"\\]/g, '');

  const prompt = [
    '<intent>rollback-conflict</intent>',
    `FAILED_COMMIT: ${failedShort} ("${safeSubject}")`,
    'COMMITS_TO_REVERT (in order, all merge commits — use `git revert -m 1`):',
    list,
  ].join('\n');

  if (runtime.busy) {
    runtime.queue.push(prompt);
  } else {
    runtime.busy = true;
    processMessage(runtime, prompt);
  }
  return true;
}

export async function handleSessionRollbackRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const { session, commits } = await listActiveSessionCommits(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session_not_found' }));
      return;
    }
    if (commits.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no_commits' }));
      return;
    }

    const reverted = [];
    let conflictAt = null;
    await withMainBranchLock(async () => {
      for (let i = 0; i < commits.length; i++) {
        const c = commits[i];
        try {
          // All session commits are merges (the merger always uses --no-ff).
          await execFileAsync('git', ['-C', CWD, 'revert', '--no-edit', '-m', '1', c.sha], GIT_BUF);
          await session.applyPatch({ markReverted: c.sha });
          reverted.push(c.sha);
        } catch (err) {
          await execFileAsync('git', ['-C', CWD, 'revert', '--abort'], GIT_BUF).catch(() => {});
          conflictAt = { failedCommit: c, remaining: commits.slice(i) };
          return;
        }
      }
    });

    if (conflictAt) {
      const chatMessage = "Undoing your changes is taking a little longer than usual — an assistant is finishing it for you. You'll see a confirmation here when it's done.";
      await setSessionState(sessionId, 'in_progress');
      await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
        .catch((e) => console.warn('[rollback] persist failed:', e.message));
      await handOffToOrchestrator(sessionId, conflictAt);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        inProgress: true,
        reverted,
        failedAt: conflictAt.failedCommit.sha,
        remaining: conflictAt.remaining.map((c) => c.sha),
        chatMessage,
      }));
      return;
    }

    const chatMessage = "All changes from this session have been undone.";
    await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
      .catch((e) => console.warn('[rollback] persist failed:', e.message));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reverted, chatMessage }));
  } catch (err) {
    console.error('handleSessionRollbackRequest failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'rollback_failed', message: err.message }));
  }
}
