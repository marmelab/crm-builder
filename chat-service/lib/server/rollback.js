import { readFile, appendFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, CLAUDE_HOME, LOG_DIR, UUID_RE } from './config.js';
import { runtimes, transitionState } from './runtime.js';
import { broadcast } from './ws-bus.js';
import { patchSession } from './session-store.js';

const execFileAsync = promisify(execFile);
const GIT_BUF = { maxBuffer: 4 * 1024 * 1024 };
const COMMIT_FORMAT = '%H%x09%P%x09%s%x09%aI';

const parseCommitLog = (out) => out.split('\n').filter(Boolean).map((line) => {
  const [sha, parents, subject, date] = line.split('\t');
  return { sha, parents: parents ? parents.split(' ') : [], subject, date };
});

// Set session state — broadcasts via runtime if one is active (so every open
// tab sees the status badge change live), otherwise writes meta.json directly
// so a later reconnect picks up the correct state.
async function setSessionState(sessionId, state) {
  const runtime = runtimes.get(sessionId);
  if (runtime?.session) {
    await transitionState(runtime, state);
    return;
  }
  await patchSession(sessionId, { state }).catch((e) => {
    console.warn('[rollback] patchSession failed:', e.message);
  });
}

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

export async function handleSessionCommitsRequest(req, res, sessionId) {
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

async function captureConflictFiles() {
  try {
    const { stdout } = await execFileAsync('git', ['-C', CWD, 'status', '--porcelain']);
    return stdout
      .split('\n')
      .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
      .map((l) => l.slice(3));
  } catch (err) {
    console.warn('[rollback] status check failed:', err.message);
    return [];
  }
}

function buildResolverPrompt({ failedCommit, conflicts, remaining }) {
  const conflictList = conflicts.length
    ? conflicts.map((f) => `  - ${f}`).join('\n')
    : '  (run `git status` to discover them)';
  const remainingList = remaining.length
    ? remaining
        .map((c) => `  - git revert --no-edit ${c.parents.length >= 2 ? '-m 1 ' : ''}${c.sha}    # ${c.subject}`)
        .join('\n')
    : '  (none)';
  return [
    'You are resolving a `git revert` conflict on /app for a CRM rollback.',
    '',
    `A revert of commit ${failedCommit.sha.slice(0, 7)} ("${failedCommit.subject}") hit a conflict.`,
    'The working tree at /app is currently in the middle of a revert with conflict markers.',
    '',
    'Conflicting files reported by `git status`:',
    conflictList,
    '',
    'What to do (operate ONLY in /app, never in /app/worktrees/):',
    '1. Resolve every conflict. The intent is to remove the changes introduced by the reverted commit — when in doubt, prefer the "incoming" side of the revert (drop the conflicting additions).',
    '2. `cd /app && git add -A && git revert --continue --no-edit` to commit the in-progress revert.',
    '3. Then revert the remaining commits in this order (stop at the first failure you cannot resolve):',
    remainingList,
    '   If a new conflict appears, repeat steps 1-2 for it.',
    '4. Never `git push`, never touch worktrees, never use --no-verify.',
    '5. When everything is reverted, print a SINGLE trailing line: `ROLLBACK_DONE`. On unrecoverable failure, print `ROLLBACK_FAILED: <one-line reason>` and run `git revert --abort` first so the tree is clean.',
  ].join('\n');
}

function spawnRollbackResolver({ sessionId, failedCommit, conflicts, remaining, alreadyReverted }) {
  const prompt = buildResolverPrompt({ failedCommit, conflicts, remaining });
  const proc = spawn('claude', [
    '--model', 'claude-sonnet-4-6',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ], {
    env: { ...process.env, HOME: CLAUDE_HOME },
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.once('error', (e) => {
    console.error('[rollback-resolver] spawn error:', e.message);
    persistAssistantMessage(sessionId,
      "Something went wrong while undoing your changes. Please try again in a moment.",
      { subtype: 'rollback' },
    ).catch(() => {});
    setSessionState(sessionId, 'completed').catch(() => {});
  });

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });

  proc.once('close', async (code) => {
    const lastLine = out.trim().split('\n').pop()?.trim() || '';
    const success = code === 0 && /^ROLLBACK_DONE\b/.test(lastLine);
    let chatMessage;
    if (success) {
      chatMessage = "All changes from this session have been undone.";
    } else {
      if (lastLine.startsWith('ROLLBACK_FAILED')) {
        const technical = lastLine.replace(/^ROLLBACK_FAILED:\s*/, '');
        console.error('[rollback-resolver] reason:', technical);
      }
      if (err) console.error('[rollback-resolver] stderr:', err.trim());
      chatMessage = "We couldn't fully undo your changes. Some of them may still be in place — please ask your administrator for help.";
    }
    await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
      .catch((e) => console.warn('[rollback-resolver] persist failed:', e.message));
    await setSessionState(sessionId, 'completed');
  });
}

export async function handleSessionRollbackRequest(req, res, sessionId) {
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
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const args = ['-C', CWD, 'revert', '--no-edit'];
      if (c.parents.length >= 2) args.push('-m', '1');
      args.push(c.sha);
      try {
        await execFileAsync('git', args, GIT_BUF);
        reverted.push(c.sha);
      } catch (err) {
        // Conflict — instead of aborting, hand off to a background agent that
        // resolves the conflict and finishes the remaining reverts.
        const conflicts = await captureConflictFiles();
        const remaining = commits.slice(i + 1);
        const chatMessage = "Undoing your changes is taking a little longer than usual — an assistant is finishing it for you. You'll see a confirmation here when it's done.";
        await setSessionState(sessionId, 'in_progress');
        await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
          .catch((e) => console.warn('[rollback] persist failed:', e.message));
        spawnRollbackResolver({
          sessionId,
          failedCommit: c,
          conflicts,
          remaining,
          alreadyReverted: reverted,
        });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          inProgress: true,
          failedAt: c.sha,
          reverted,
          conflicts,
          chatMessage,
          message: (err.stderr || err.message || '').toString(),
        }));
        return;
      }
    }
    const chatMessage = "All changes from this session have been undone.";
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
