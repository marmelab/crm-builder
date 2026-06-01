import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, UUID_RE } from './config.js';
import { runtimes, createRuntime, setSessionState, persistAssistantMessage } from './runtime.js';
import { openSession } from './session-store.js';
import { processMessage } from './turn.js';

const SHORT_ID_RE = /^[0-9a-f]{8}$/i;

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
// Scanning all reachable commits for that marker tells us which promotion
// commits have already been undone, so multiple rollbacks on the same
// session never try to revert the same commit twice.
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

// Source of truth: the git graph. Promotion commits land on main as
// `git merge --no-ff session/<SHORT_ID>`, so their second parent traces
// back through the session branch. `--ancestry-path session/<id>..HEAD`
// returns exactly those merge commits — one per completed request in this
// session — without touching meta.json or any recorded SHA list.
// Already-reverted commits are excluded via findRevertedFullShas().
async function listActiveSessionCommits(sessionId) {
  const session = runtimes.get(sessionId)?.session || await openSession(sessionId);
  if (!session) return { session: null, commits: [] };
  const shortId = sessionId.split('-')[0];
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '--ancestry-path', '--merges',
        '--format=%H\t%s', `session/${shortId}..HEAD`],
      GIT_BUF,
    ));
  } catch (err) {
    console.warn('[rollback] listActiveSessionCommits git log failed:', err.message);
    return { session, commits: [] };
  }
  const reverted = await findRevertedFullShas();
  const commits = stdout.trim().split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  }).filter((c) => !reverted.has(c.sha));
  return { session, commits };
}

// Simulates `git revert -m 1 <sha>` against current HEAD without touching
// the working tree. Returns true iff the revert would produce conflict
// markers. Uses modern `git merge-tree` (Git ≥ 2.38): a 3-way merge where
// merge-base = <sha>, ours = HEAD, theirs = <sha>'s first parent (the
// pre-merge state) — the exact tree git produces for a `revert -m 1`.
//
// Exit codes: 0 = clean, 1 = conflict, ≥2 = error (treat as "unknown" →
// no warning, don't block the user on tooling).
async function wouldRevertConflict(sha) {
  try {
    await execFileAsync(
      'git',
      ['-C', CWD, 'merge-tree', `--merge-base=${sha}`, 'HEAD', `${sha}^1`],
      GIT_BUF,
    );
    return false;
  } catch (err) {
    if (err.code === 1) return true;
    console.warn('[rollback] wouldRevertConflict failed for', sha, ':', err.message);
    return false;
  }
}

export async function handleSessionCommitsRequest(req, res, sessionId) {

  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    const { commits } = await listActiveSessionCommits(sessionId);
    // For each commit, dry-run its revert to know whether it would conflict.
    // Parallel because each call is independent (read-only against the repo).
    const enriched = await Promise.all(commits.map(async (c) => ({
      ...c,
      wouldConflict: await wouldRevertConflict(c.sha),
    })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId, commits: enriched }));
  } catch (err) {
    console.error('handleSessionCommitsRequest failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'commits_lookup_failed', message: err.message }));
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
