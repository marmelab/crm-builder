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

function buildOrchestratorPrompt({ failedCommit, conflicts, remaining }) {
  const conflictList = conflicts.length
    ? conflicts.map((f) => `    - ${f}`).join('\n')
    : '    (run `git status` in /app to discover them)';
  const remainingList = remaining.length
    ? remaining
        .map((c) => `    - ${c.parents.length >= 2 ? '-m 1 ' : ''}${c.sha}    # ${c.subject}`)
        .join('\n')
    : '    (none)';

  const failedShort = failedCommit.sha.slice(0, 7);
  const safeSubject = failedCommit.subject.replace(/[`"\\]/g, '');

  return [
    'You are the team-lead for a CRM rollback conflict resolution. A `git revert` on /app is mid-conflict and you must dispatch a team to finish the rollback.',
    '',
    `ROLLBACK CONTEXT:`,
    `  - Failed commit: ${failedShort} ("${safeSubject}")`,
    `  - Working tree: /app (REVERT_HEAD is set — a revert is in progress)`,
    `  - Conflicting files reported by git:`,
    conflictList,
    `  - Remaining commits to revert (in order, after the in-progress one is finalised):`,
    remainingList,
    '',
    'WORKFLOW — execute exactly this and nothing else:',
    '',
    '1. Create the team:',
    '   TeamCreate({team_name: "rollback", description: "Rollback conflict resolution"})',
    '',
    '2. Dispatch the three members in ONE assistant message:',
    '   Agent({subagent_type: "simple-developer", name: "simple-developer", team_name: "rollback", model: "sonnet",',
    '          description: "Resolve rollback conflict",',
    '          prompt: "ROLLBACK_PROMPT_SIMPLE_DEVELOPER (see template below)"})',
    '   Agent({subagent_type: "quality-reviewer", name: "quality-reviewer", team_name: "rollback", model: "sonnet",',
    '          description: "Review rollback resolution",',
    '          prompt: "ROLLBACK_PROMPT_QUALITY_REVIEWER (see template below)"})',
    '   Agent({subagent_type: "merger", name: "merger", team_name: "rollback", model: "haiku",',
    '          description: "Finalise rollback reverts",',
    '          prompt: "ROLLBACK_PROMPT_MERGER (see template below)"})',
    '',
    '3. Send GO to simple-developer (one SendMessage in the same turn as step 2 is OK):',
    `   SendMessage({to: "simple-developer", message: "GO — resolve the rollback conflict. failed_commit=${failedShort}; remaining=${remaining.length}"})`,
    '',
    '4. PASSIVE WAIT. Each turn, output one short text line ("Working on rollback...") only if your last message was different. No tool calls.',
    '   Watch for a SendMessage from `merger` containing either:',
    '     - `ROLLBACK_DONE` → success, proceed to step 5',
    '     - `ROLLBACK_FAILED: <reason>` → failure, proceed to step 5',
    '',
    '5. TEARDOWN (when merger has reported):',
    '   SendMessage({to: "simple-developer", message: {type: "shutdown_request"}})',
    '   SendMessage({to: "quality-reviewer", message: {type: "shutdown_request"}})',
    '   SendMessage({to: "merger", message: {type: "shutdown_request"}})',
    '   Then yield (text-only). On next turn, when shutdown_approved arrives: TeamDelete({}).',
    '',
    '6. FINAL OUTPUT. After TeamDelete, output a SINGLE final line on stdout, the LAST line you ever produce:',
    '     - `ROLLBACK_DONE` on success',
    '     - `ROLLBACK_FAILED: <one-line reason>` on failure',
    '   (The chat-service parses the last line of your stdout.)',
    '',
    '## SPAWN PROMPT TEMPLATES',
    '',
    '### ROLLBACK_PROMPT_SIMPLE_DEVELOPER',
    '```',
    'ROLE: simple-developer',
    'MODE: ROLLBACK_CONFLICT',
    'TEAM: rollback',
    'WORK_DIR: /app',
    `FAILED_COMMIT: ${failedShort} ("${safeSubject}")`,
    `CONFLICT_FILES: ${conflicts.join(', ') || '(see git status)'}`,
    'COUNTERPARTS:',
    '  - reviewer: quality-reviewer',
    '  - merger: merger',
    'TEAM_LEAD: team-lead',
    '',
    'Follow the ROLLBACK_CONFLICT workflow in simple-developer.md. Do NOT call Skill({skill: "agent-team"}).',
    '```',
    '',
    '### ROLLBACK_PROMPT_QUALITY_REVIEWER',
    '```',
    'ROLE: quality-reviewer',
    'MODE: ROLLBACK_CONFLICT',
    'TEAM: rollback',
    'WORK_DIR: /app',
    'COUNTERPART: simple-developer',
    'TEAM_LEAD: team-lead',
    '',
    'Follow the ROLLBACK_CONFLICT workflow in quality-reviewer.md. Do NOT call any tool until simple-developer sends "ready, please review".',
    '```',
    '',
    '### ROLLBACK_PROMPT_MERGER',
    '```',
    'ROLE: merger',
    'MODE: ROLLBACK_CONFLICT',
    'TEAM: rollback',
    'WORK_DIR: /app',
    'REMAINING_REVERTS:',
    remainingList,
    'COUNTERPARTS:',
    '  - developer: simple-developer',
    'TEAM_LEAD: team-lead',
    '',
    'Follow the ROLLBACK_CONFLICT workflow in merger.md. Do NOT call any tool until simple-developer sends a "ready: finalise revert" message.',
    '```',
  ].join('\n');
}

function spawnRollbackTeamLead({ sessionId, sessionDir, failedCommit, conflicts, remaining, alreadyReverted }) {
  const prompt = buildOrchestratorPrompt({ failedCommit, conflicts, remaining });
  const proc = spawn('claude', [
    '--model', 'claude-sonnet-4-6',
    '--dangerously-skip-permissions',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '-p', prompt,
  ], {
    env: {
      ...process.env,
      HOME: CLAUDE_HOME,
      CLAUDE_PROJECT_DIR: CWD,
      CHAT_SESSION_DIR: sessionDir,
      CLAUDE_ROLLBACK_MODE: '1',
    },
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.once('error', (e) => {
    console.error('[rollback-team-lead] spawn error:', e.message);
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
    // The team-lead emits one final line on stdout — scan from the end for the
    // most recent ROLLBACK_DONE / ROLLBACK_FAILED marker. Trailing whitespace,
    // text turns, and stream-json metadata may follow, so don't trust the very
    // last line blindly.
    const lines = out.trim().split('\n').reverse();
    const marker = lines.find((l) => /\bROLLBACK_(DONE|FAILED)\b/.test(l)) || '';
    const success = code === 0 && /\bROLLBACK_DONE\b/.test(marker);
    let chatMessage;
    if (success) {
      chatMessage = "All changes from this session have been undone.";
    } else {
      const failMatch = marker.match(/ROLLBACK_FAILED:\s*(.*)$/);
      if (failMatch) {
        console.error('[rollback-team-lead] reason:', failMatch[1]);
      }
      if (err) console.error('[rollback-team-lead] stderr:', err.trim());
      chatMessage = "We couldn't fully undo your changes. Some of them may still be in place — please ask your administrator for help.";
    }
    await persistAssistantMessage(sessionId, chatMessage, { subtype: 'rollback' })
      .catch((e) => console.warn('[rollback-team-lead] persist failed:', e.message));
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
        spawnRollbackTeamLead({
          sessionId,
          sessionDir: `${LOG_DIR}/${sessionId}`,
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
