import { readFile, stat, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CWD, LOG_DIR, UUID_RE } from './config.js';
import { runtimes, createRuntime, setSessionState, persistAssistantMessage } from './runtime.js';
import { openSession } from './session-store.js';
import { processMessage } from './turn.js';

const execFileAsync = promisify(execFile);
const GIT_BUF = { maxBuffer: 4 * 1024 * 1024 };
const COMMIT_FORMAT = '%H%x09%P%x09%s%x09%aI';

// First UUID segment — same SESSION_SHORT convention used everywhere else
// (hooks, worktree paths, branch names).
const sessionShortFromId = (sessionId) => sessionId.split('-')[0];
const rollbackWorktreePath = (sessionShort) => `/app/worktrees/${sessionShort}`;
const rollbackBranchName = (sessionShort) => `rollback/${sessionShort}`;

const parseCommitLog = (out) => out.split('\n').filter(Boolean).map((line) => {
  const [sha, parents, subject, date] = line.split('\t');
  return { sha, parents: parents ? parents.split(' ') : [], subject, date };
});

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

// Create (or reuse) a dedicated worktree for the session's rollback so that
// `git revert` doesn't touch /app's working tree. The rollback occupies the
// session's worktree namespace directly: /app/worktrees/<SESSION_SHORT>.
// Idempotent: a retried HTTP rollback call reuses the existing worktree.
// At rollback time the session is ending, so any sibling per-task worktrees
// still registered under this prefix are force-removed first (their tasks
// either completed and were cleaned up by SubagentStop, or failed and the
// rollback supersedes them either way).
async function ensureRollbackWorktree(sessionShort) {
  const worktreePath = rollbackWorktreePath(sessionShort);
  const branchName = rollbackBranchName(sessionShort);

  const { stdout: wtList } = await execFileAsync(
    'git',
    ['-C', CWD, 'worktree', 'list', '--porcelain'],
    GIT_BUF,
  );
  if (wtList.includes(`worktree ${worktreePath}\n`)) {
    return { worktreePath, branchName, reused: true };
  }

  // Force-remove any sibling worktrees still registered under this session
  // (e.g. /app/worktrees/<short>/TASK-001) — they would prevent `worktree add`
  // on the parent dir.
  for (const line of wtList.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    if (path.startsWith(`${worktreePath}/`)) {
      await execFileAsync('git', ['-C', CWD, 'worktree', 'remove', '--force', path], GIT_BUF)
        .catch((e) => console.warn('[rollback] sibling worktree remove failed:', path, e.message));
    }
  }

  // Orphan dir not registered with git → wipe before `worktree add`.
  try {
    await stat(worktreePath);
    await rm(worktreePath, { recursive: true, force: true });
  } catch {}

  // Orphan branch with no worktree → force-delete so `-b` works.
  await execFileAsync('git', ['-C', CWD, 'branch', '-D', branchName], GIT_BUF)
    .catch(() => {});

  await mkdir('/app/worktrees', { recursive: true });
  await execFileAsync(
    'git',
    ['-C', CWD, 'worktree', 'add', worktreePath, '-b', branchName, 'HEAD'],
    GIT_BUF,
  );

  // Hard-link node_modules so any validation that does reach this worktree
  // (manual or otherwise) has the deps available at zero disk cost.
  try {
    await stat(`${worktreePath}/node_modules`);
  } catch {
    await execFileAsync('cp', ['-al', '/app/node_modules', `${worktreePath}/node_modules`]);
  }

  return { worktreePath, branchName, reused: false };
}

// Clean path only: merge the rollback branch back into the base branch and
// remove the worktree + branch. The conflict path leaves the worktree intact
// for the rollback team to finish — the merger agent handles its cleanup.
async function finaliseRollbackOnBase(sessionShort, { worktreePath, branchName }) {
  await execFileAsync(
    'git',
    ['-C', CWD, 'merge', '--no-ff', '-m', `chore: rollback session ${sessionShort}`, branchName],
    GIT_BUF,
  );
  await execFileAsync('git', ['-C', CWD, 'worktree', 'remove', '--force', worktreePath], GIT_BUF)
    .catch((e) => console.warn('[rollback] worktree remove failed:', e.message));
  await execFileAsync('git', ['-C', CWD, 'branch', '-D', branchName], GIT_BUF)
    .catch((e) => console.warn('[rollback] branch -D failed:', e.message));
}

async function captureConflictFiles(worktreePath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain']);
    return stdout
      .split('\n')
      .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
      .map((l) => l.slice(3));
  } catch (err) {
    console.warn('[rollback] status check failed:', err.message);
    return [];
  }
}

function buildOrchestratorPrompt({ failedCommit, conflicts, remaining, worktreePath, branchName }) {
  const conflictList = conflicts.length
    ? conflicts.map((f) => `  - ${f}`).join('\n')
    : `  (run \`git status\` in ${worktreePath} to discover them)`;
  const remainingList = remaining.length
    ? remaining
        .map((c) => `  - ${c.parents.length >= 2 ? '-m 1 ' : ''}${c.sha}    # ${c.subject}`)
        .join('\n')
    : '  (none)';

  const failedShort = failedCommit.sha.slice(0, 7);
  const safeSubject = failedCommit.subject.replace(/[`"\\]/g, '');

  // Plain user-style turn the chat-orchestrator picks up via its ROLLBACK
  // classification (matches the explicit `<intent>` marker). Everything below
  // the intent line is structured context the orchestrator copies into the
  // rollback team spawn prompts.
  return [
    '<intent>rollback-conflict</intent>',
    `WORKTREE_PATH: ${worktreePath}`,
    `BRANCH_NAME: ${branchName}`,
    `FAILED_COMMIT: ${failedShort} ("${safeSubject}")`,
    'CONFLICT_FILES:',
    conflictList,
    'REMAINING_REVERTS:',
    remainingList,
  ].join('\n');
}

// Hand the conflict over to the chat-orchestrator: ensure a runtime exists,
// flag the session as rollback-in-progress (so the next spawn carries
// CLAUDE_ROLLBACK_MODE=1 for the hooks), then enqueue/dispatch the synthetic
// user turn through the normal processMessage path.
async function handOffToOrchestrator(sessionId, { failedCommit, conflicts, remaining, worktreePath, branchName }) {
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

  await runtime.session.applyPatch({ rollbackInProgress: true })
    .catch((e) => console.warn('[rollback] flag set failed:', e.message));

  const prompt = buildOrchestratorPrompt({ failedCommit, conflicts, remaining, worktreePath, branchName });
  if (runtime.busy) {
    runtime.queue.push(prompt);
  } else {
    runtime.busy = true;
    // Fire-and-forget — processMessage owns its own lifecycle.
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
    const commits = await loadActiveSessionCommits(`${LOG_DIR}/${sessionId}`);
    if (commits.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no_commits' }));
      return;
    }

    const sessionShort = sessionShortFromId(sessionId);
    const { worktreePath, branchName } = await ensureRollbackWorktree(sessionShort);

    const reverted = [];
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const args = ['-C', worktreePath, 'revert', '--no-edit'];
      if (c.parents.length >= 2) args.push('-m', '1');
      args.push(c.sha);
      try {
        await execFileAsync('git', args, GIT_BUF);
        reverted.push(c.sha);
      } catch (err) {
        // Conflict — leave the worktree in mid-revert state and hand off to
        // the chat-orchestrator, which dispatches the rollback team
        // (simple-developer + quality-reviewer + merger in ROLLBACK_CONFLICT
        // mode) to finish the rollback inside the worktree.
        const conflicts = await captureConflictFiles(worktreePath);
        const remaining = commits.slice(i + 1);
        const chatMessage = "Undoing your changes is taking a little longer than usual — an assistant is finishing it for you. You'll see a confirmation here when it's done.";
        await setSessionState(sessionId, 'in_progress');
        await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
          .catch((e) => console.warn('[rollback] persist failed:', e.message));
        await handOffToOrchestrator(sessionId, {
          failedCommit: c,
          conflicts,
          remaining,
          worktreePath,
          branchName,
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
    // Clean path — every revert succeeded in the worktree. Merge the rollback
    // branch back into the base and tear down the worktree so the base sees
    // the revert commits and the worktree directory disappears.
    try {
      await finaliseRollbackOnBase(sessionShort, { worktreePath, branchName });
    } catch (mergeErr) {
      console.error('[rollback] finalise failed:', mergeErr);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'merge_back_failed',
        reverted,
        message: (mergeErr.stderr || mergeErr.message || '').toString(),
      }));
      return;
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
