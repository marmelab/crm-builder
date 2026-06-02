import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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

// `git revert` writes `This reverts commit <full sha>` in the body. Scanning all
// reachable commits for that marker tells us which promotion commits have already
// been undone, so multiple rollbacks on the same session never revert the same
// commit twice. Two marker shapes exist: single-parent reverts end the line with
// `.`; merge reverts (`-m 1` — all our cases) continue with `, reversing changes
// made to <parent>.`. A bare slice would capture the `, reversing` tail and never
// match a 40-hex SHA, so extract the SHA directly. Our batched revert below writes
// the same marker (one line per commit) so both code paths stay idempotent.
async function findRevertedFullShas() {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', CWD, 'log', '--all', '--grep=This reverts commit', '--format=%B'],
      GIT_BUF,
    );
    const reverted = new Set();
    const re = /This reverts commit ([0-9a-f]{40})/g;  // fresh per call — /g lastIndex is stateful
    let m;
    while ((m = re.exec(stdout)) !== null) reverted.add(m[1]);
    return reverted;
  } catch (err) {
    console.warn('[rollback] findRevertedFullShas failed:', err.message);
    return new Set();
  }
}

// The default branch is the promotion target (see merger.md). We never trust
// /app's current HEAD: it can drift onto a previous session's branch, and the
// merger's #61 fix realigns onto the default branch for exactly this reason.
// Mirror that resolution here so rollback queries and reverts always target
// the real main.
async function resolveDefaultBranch() {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', CWD, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], GIT_BUF,
    );
    const name = stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  } catch { /* no origin/HEAD — fall through */ }
  try {
    await execFileAsync('git', ['-C', CWD, 'show-ref', '--verify', '--quiet', 'refs/heads/master'], GIT_BUF);
    return 'master';
  } catch { /* no master */ }
  return 'main';
}

// Realign /app onto the default branch if it has drifted (or detached), so the
// revert commits land on the promotion target and not on a stale branch. The
// common case — already on the default branch — does nothing. When we do move,
// we mirror the merger: drop working-tree debris, checkout, then re-apply the
// App.tsx variant the checkout wipes out.
async function ensureOnDefaultBranch(def) {
  let current = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', CWD, 'symbolic-ref', '--short', 'HEAD'], GIT_BUF);
    current = stdout.trim();
  } catch { /* detached HEAD */ }
  if (current === def) return;
  await execFileAsync('git', ['-C', CWD, 'reset', '--hard', 'HEAD'], GIT_BUF);
  await execFileAsync('git', ['-C', CWD, 'checkout', def], GIT_BUF);
  await execFileAsync('/entrypoint-helpers/apply-app-variant.sh', [], { cwd: CWD })
    .catch((e) => console.warn('[rollback] apply-app-variant failed:', e.message));
}

// Source of truth: the git graph, via parentage — NOT the merge subject (too
// brittle, and the old meta.commits SHA list is gone). Each completed request
// promotes with `git merge --no-ff session/<SHORT_ID>`, so a promotion is a
// merge commit whose SECOND parent (`^2`) is the session tip at promotion time,
// i.e. a commit reachable from `session/<id>`. We list the merges in
// `session/<id>..<tipRef>` — which includes ALL of this session's promotions
// (`--ancestry-path` would wrongly keep only the most recent, since earlier
// promotions aren't descendants of the current session tip) — then keep only
// those whose 2nd parent lives on this session's branch. Other sessions'
// promotions (different 2nd parent) and already-reverted commits drop out.
async function listSessionPromotions(sessionId, tipRef) {
  const shortId = sessionId.split('-')[0];
  const sessionRef = `session/${shortId}`;
  // A missing session branch is NOT the same as "no commits to undo": we simply
  // can't compute this session's promotions from the graph, and reporting an
  // empty list would tell the user "nothing to undo" while their changes are
  // still live on the default branch. Surface it distinctly instead.
  const branchExists = await execFileAsync(
    'git', ['-C', CWD, 'show-ref', '--verify', '--quiet', `refs/heads/${sessionRef}`], GIT_BUF,
  ).then(() => true).catch(() => false);
  if (!branchExists) {
    const e = new Error(`session branch ${sessionRef} not found`);
    e.code = 'SESSION_BRANCH_MISSING';
    throw e;
  }
  const [logResult, sessionRevs, reverted] = await Promise.all([
    execFileAsync(
      'git',
      ['-C', CWD, 'log', '--merges', '--format=%H\t%P\t%s', `${sessionRef}..${tipRef}`],
      GIT_BUF,
    ).catch((err) => {
      console.warn('[rollback] listSessionPromotions git log failed:', err.message);
      return null;
    }),
    // Every commit reachable from the session tip. A promotion's 2nd parent is
    // always in this set; another session's promotion 2nd parent is not.
    execFileAsync('git', ['-C', CWD, 'rev-list', sessionRef], GIT_BUF).catch(() => ({ stdout: '' })),
    findRevertedFullShas(),
  ]);
  if (!logResult) return [];
  const onSession = new Set(sessionRevs.stdout.split('\n').filter(Boolean));
  return logResult.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return { sha: parts[0], parents: (parts[1] || '').split(' ').filter(Boolean), subject: parts.slice(2).join('\t') };
  }).filter((c) => c.parents.length >= 2 && onSession.has(c.parents[1]) && !reverted.has(c.sha))
    .map((c) => ({ sha: c.sha, subject: c.subject }));
}

// Simulates `git revert -m 1 <sha>` against <tipRef> without touching the
// working tree. Returns true iff the revert would produce conflict markers.
// Uses modern `git merge-tree` (Git ≥ 2.38): a 3-way merge where
// merge-base = <sha>, ours = <tipRef> (the default branch — never the drifting
// HEAD), theirs = <sha>'s first parent (the pre-merge state) — the exact tree
// git produces for a `revert -m 1`.
//
// Exit codes: 0 = clean, 1 = conflict, ≥2 = error (treat as "unknown" →
// no warning, don't block the user on tooling).
async function wouldRevertConflict(sha, tipRef) {
  try {
    await execFileAsync(
      'git',
      ['-C', CWD, 'merge-tree', `--merge-base=${sha}`, tipRef, `${sha}^1`],
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
    const def = await resolveDefaultBranch();
    const commits = await listSessionPromotions(sessionId, def);
    // For each commit, dry-run its revert to know whether it would conflict.
    // Parallel because each call is independent (read-only against the repo).
    const enriched = await Promise.all(commits.map(async (c) => ({
      ...c,
      wouldConflict: await wouldRevertConflict(c.sha, def),
    })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId, commits: enriched }));
  } catch (err) {
    if (err?.code === 'SESSION_BRANCH_MISSING') {
      // Distinct from an empty list: tell the client we can't determine the
      // changes, so it shows that instead of a misleading "nothing to undo".
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId, commits: [], unavailable: true }));
      return;
    }
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
async function handOffToOrchestrator(sessionId, { failedCommit, remaining, base }) {
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
    // The agent must replay the reverts against the SAME state the HTTP route
    // hit the conflict on — the current default branch — not the stale session
    // branch its worktree was forked from. Without this it reverts cleanly on a
    // base where the conflict doesn't exist, and the conflict only resurfaces
    // (unresolved) at promotion time.
    `BASE_BRANCH: ${base}`,
    `FAILED_COMMIT: ${failedShort} ("${safeSubject}")`,
    'COMMITS_TO_REVERT (in order, all merge commits — use `git revert -m 1`):',
    list,
  ].join('\n');

  if (runtime.busy) {
    // Queue items are {id, content} everywhere (server.js) and the consumer
    // reads `next.content` / `q.id` (turn.js). Pushing a bare string would make
    // the dequeued turn spawn with an undefined prompt and break queue badges.
    runtime.queue.push({ id: ++runtime.queueIdSeq, content: prompt });
  } else {
    runtime.busy = true;
    processMessage(runtime, prompt);
  }
  return true;
}

// Unmerged paths left by a failed `git revert` in `dir`. A genuine merge conflict
// leaves `UU`/`AA`/`DD`/… entries; an operational failure (dirty tree, lock, bad
// object, "nothing to commit") leaves none. Must be read BEFORE `revert --abort`
// clears the conflicted state.
async function listUnmergedConflictPaths(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'status', '--porcelain'], GIT_BUF);
    return stdout.split('\n').filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l)).map((l) => l.slice(3));
  } catch { return []; }
}

// Throwaway worktree forked from `base`, used to compute the reverts WITHOUT
// touching /app (the tree Vite serves) — so a conflict never flashes half-applied
// files at the user. Pure git: no node_modules, nothing is built here. Clears any
// stale registration/dir/branch from a previous rollback first.
async function prepareRollbackWorktree(wt, branch, base) {
  await execFileAsync('git', ['-C', CWD, 'worktree', 'remove', '--force', wt], GIT_BUF).catch(() => {});
  await execFileAsync('git', ['-C', CWD, 'worktree', 'prune'], GIT_BUF).catch(() => {});
  await execFileAsync('git', ['-C', CWD, 'branch', '-D', branch], GIT_BUF).catch(() => {});
  await mkdir(dirname(wt), { recursive: true });
  await execFileAsync('git', ['-C', CWD, 'worktree', 'add', wt, '-b', branch, base], GIT_BUF);
}

async function cleanupRollbackWorktree(wt, branch) {
  await execFileAsync('git', ['-C', CWD, 'worktree', 'remove', '--force', wt], GIT_BUF).catch(() => {});
  await execFileAsync('git', ['-C', CWD, 'worktree', 'prune'], GIT_BUF).catch(() => {});
  await execFileAsync('git', ['-C', CWD, 'branch', '-D', branch], GIT_BUF).catch(() => {});
}

// Promote the rollback branch straight into the default branch — never via
// session/<id>, so the session branch (and the deploy-time migration diff that
// reads session-base/<id>..session/<id>) stays free of unrelated history. Mirrors
// the merger's Stage B: realign /app onto the default branch, then merge under the
// promote flock (cross-process mutual exclusion with the merger's own promotions).
// Args are passed as bash positionals — never interpolated — so nothing is
// shell-injectable. Returns false on merge conflict (the default branch moved
// under us) so the caller can escalate to the agent.
async function promoteBranchToDefault(branch, def, message) {
  await ensureOnDefaultBranch(def);
  try {
    await execFileAsync('flock', [
      '/app/.promote.lock', 'bash', '-c',
      'cd "$1" && git merge --no-ff "$2" -m "$3" || { git merge --abort; exit 1; }',
      '_', CWD, branch, message,
    ], GIT_BUF);
  } catch {
    return false;
  }
  await execFileAsync('/entrypoint-helpers/apply-app-variant.sh', [], { cwd: CWD })
    .catch((e) => console.warn('[rollback] apply-app-variant failed:', e.message));
  return true;
}

export async function handleSessionRollbackRequest(req, res, sessionId) {
  if (!UUID_RE.test(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_sessionId' }));
    return;
  }
  try {
    // Cheap existence check before taking the lock; the authoritative commit
    // list is computed inside the lock against the default branch (below).
    const session = runtimes.get(sessionId)?.session || await openSession(sessionId).catch(() => null);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session_not_found' }));
      return;
    }
    // A rollback resets /app and reverts on the shared working tree. If a turn is
    // already running for this session, reverting underneath it corrupts the
    // in-flight work — refuse server-side (the client isBusy() gate is advisory,
    // not authoritative). Re-checked under the lock below to close the race.
    if (runtimes.get(sessionId)?.busy) {
      res.writeHead(423, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session_busy',
        chatMessage: 'Please wait for the current task to finish before undoing this session.' }));
      return;
    }

    const reverted = [];
    let conflictAt = null;
    let noCommits = false;
    let branchMissing = false;
    let busyRace = false;
    // Everything that reads then mutates the base branch runs inside the lock:
    // resolve + realign onto the default branch, snapshot the commit list, then
    // revert. Snapshotting inside the lock stops a concurrent rollback from
    // computing the same list and re-reverting commits the other one just undid.
    await withMainBranchLock(async () => {
      // Authoritative busy re-check: a turn may have started between the cheap
      // pre-lock check and acquiring the lock.
      if (runtimes.get(sessionId)?.busy) { busyRace = true; return; }
      const def = await resolveDefaultBranch();
      // Compute the commit list BEFORE touching the working tree. listSessionPromotions
      // is ref-based (independent of what's checked out), so we avoid the destructive
      // `ensureOnDefaultBranch` reset --hard when there is nothing to undo or the
      // session branch is missing.
      let commits;
      try {
        commits = await listSessionPromotions(sessionId, def);
      } catch (e) {
        if (e?.code === 'SESSION_BRANCH_MISSING') { branchMissing = true; return; }
        throw e;
      }
      if (commits.length === 0) { noCommits = true; return; }
      // Never revert on /app (the tree Vite serves): a conflict would flash
      // half-applied / marker-laden files at the user. Compute the reverts in a
      // throwaway worktree forked from the default branch; /app only ever changes
      // via the clean promotion merge below (one hot-reload, a state that compiles).
      // All session commits are merges (merger uses --no-ff) → `-m 1`.
      const shas = commits.map((c) => c.sha);
      const short = sessionId.split('-')[0];
      const rbBranch = `${short}/rollback`;
      const rbWorktree = `${CWD}/worktrees/${short}/_rollback`;
      try {
        await prepareRollbackWorktree(rbWorktree, rbBranch, def);
        try {
          await execFileAsync('git', ['-C', rbWorktree, 'revert', '--no-commit', '-m', '1', ...shas], GIT_BUF);
        } catch (err) {
          // Genuine merge conflict (unmerged paths) → hand to the agent. Any other
          // failure (bad object, lock) → surface as an error rather than a false
          // conflict that the agent would "resolve" against a clean base.
          const conflictFiles = await listUnmergedConflictPaths(rbWorktree);
          await execFileAsync('git', ['-C', rbWorktree, 'revert', '--abort'], GIT_BUF).catch(() => {});
          if (conflictFiles.length === 0) throw err;
          conflictAt = { failedCommit: commits[0], remaining: commits, base: def };
          return;
        }
        // Seal the reverts into ONE commit carrying every `This reverts commit`
        // marker (a plain commit keeps only the last; findRevertedFullShas reads
        // them to make a second rollback idempotent), then promote straight into
        // the default branch — never via session/<id>.
        const body = shas.map((sha) => `This reverts commit ${sha}.`).join('\n');
        const subject = `Revert ${shas.length} session commit${shas.length > 1 ? 's' : ''} (rollback ${short})`;
        await execFileAsync('git', ['-C', rbWorktree, 'commit', '-m', `${subject}\n\n${body}`], GIT_BUF);
        const promoted = await promoteBranchToDefault(rbBranch, def, subject);
        if (promoted) reverted.push(...shas);
        // Promote conflict means the default branch moved under us — escalate to
        // the agent, which resets onto the *current* default branch and resolves.
        else conflictAt = { failedCommit: commits[0], remaining: commits, base: def };
      } finally {
        await cleanupRollbackWorktree(rbWorktree, rbBranch);
      }
    });
    if (busyRace) {
      res.writeHead(423, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session_busy',
        chatMessage: 'Please wait for the current task to finish before undoing this session.' }));
      return;
    }
    if (branchMissing) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session_branch_missing',
        chatMessage: "We couldn't determine this session's changes to undo. Please contact your administrator." }));
      return;
    }
    if (noCommits) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no_commits' }));
      return;
    }

    if (conflictAt) {
      const chatMessage = "Undoing your changes is taking a little longer than usual — an assistant is finishing it for you. You'll see a confirmation here when it's done.";
      await Promise.all([
        setSessionState(sessionId, 'in_progress'),
        persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
          .catch((e) => console.warn('[rollback] persist failed:', e.message)),
        handOffToOrchestrator(sessionId, conflictAt),
      ]);
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
