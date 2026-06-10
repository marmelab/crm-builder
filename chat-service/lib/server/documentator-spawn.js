import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CWD, CLAUDE_HOME, LOG_DIR } from './config.js';
import { getDocumentatorPrompt, getDocumentatorModel } from './system-prompt.js';
import { buildSpawnEnv } from '../spawn-env.js';

// Idle gap between the orchestrator finishing a turn and the documentator
// firing. New user messages reset the timer so back-to-back turns don't each
// trigger a synthesis pass.
export const DOCUMENTATOR_DEBOUNCE_MS = 30_000;

// Hard ceiling for a single documentator spawn. A hung `claude -p` (network
// stall, prompt-cache miss with no progress) would otherwise leak the child
// process indefinitely.
export const DOCUMENTATOR_TIMEOUT_MS = 5 * 60_000;

// Session-keyed timer map. Storing the timer on the runtime breaks when the
// runtime is released between turns (clients.size===0 → runtime deleted),
// because a reconnecting client gets a fresh runtime whose null timer cannot
// cancel the orphan. Keying on sessionId survives runtime lifecycle.
const sessionTimers = new Map();

export function clearDocumentatorTimer(sessionId) {
  const t = sessionTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    sessionTimers.delete(sessionId);
  }
}

export function scheduleDocumentatorRun(sessionId, runtimes) {
  clearDocumentatorTimer(sessionId);
  const t = setTimeout(() => {
    sessionTimers.delete(sessionId);
    // A new turn may have started in the meantime — skip if so; that turn
    // will re-schedule us once it finishes.
    const current = runtimes.get(sessionId);
    if (current?.busy) return;
    spawnDocumentator(sessionId).catch((err) => {
      console.error('[documentator]', err?.message || err);
    });
  }, DOCUMENTATOR_DEBOUNCE_MS);
  sessionTimers.set(sessionId, t);
}

// Returns true if at least one TASK-*.json file in the session dir has
// status === "merged". The documentator's Mode 2 only has anything to do when
// real work was merged on this branch — pure question/answer turns produce
// nothing for it to synthesise.
export async function sessionHasMergedTickets(sessionDir) {
  let entries;
  try {
    entries = await readdir(sessionDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^TASK-\d+\.json$/i.test(entry)) continue;
    try {
      const ticket = JSON.parse(await readFile(join(sessionDir, entry), 'utf8'));
      if (ticket?.status === 'merged') return true;
    } catch {}
  }
  return false;
}

// True if the session has at least one ticket that is NOT in a terminal state
// (merged/failed) — i.e. a COMPLEX wave that did not finish. Used by the
// teardown-stall watcher to decide whether an idle-killed spawn left real work
// undone (worth an auto-resume) vs a genuinely complete run.
export async function sessionHasPendingTickets(sessionDir) {
  let entries;
  try {
    entries = await readdir(sessionDir);
  } catch {
    return false;
  }
  const TERMINAL = new Set(['merged', 'failed']);
  for (const entry of entries) {
    if (!/^TASK-\d+\.json$/i.test(entry)) continue;
    try {
      const ticket = JSON.parse(await readFile(join(sessionDir, entry), 'utf8'));
      if (!TERMINAL.has(ticket?.status)) return true;
    } catch {}
  }
  return false;
}

// Spawns the documentator as an isolated `claude -p` call (no --resume).
// Mode 2: reads the session log + git diff vs origin/main and appends
// business-knowledge bullets to /app/MEMORY.md. Silent: output is captured to
// the session's documentator.log, never broadcast to the chat UI.
export async function spawnDocumentator(sessionId) {
  const sessionDir = `${LOG_DIR}/${sessionId}`;
  const systemPrompt = getDocumentatorPrompt();
  if (!systemPrompt) return { exitCode: -1, error: 'documentator prompt not loaded' };

  const model = getDocumentatorModel();
  const userPrompt = [
    'ROLE: documentator (Mode 2)',
    `SESSION_LOG: ${sessionDir}/log.jsonl`,
    'SESSION_DIFF_BASE: origin/main',
    'reason: business-knowledge',
  ].join('\n');
  const prompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userPrompt}`;

  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  if (model) args.push('--model', model);
  args.push('-p', prompt);

  const logPath = `${sessionDir}/documentator.log`;
  await appendFile(logPath, `\n=== ${new Date().toISOString()} spawn ===\n`).catch(() => {});

  const proc = spawn('claude', args, {
    env: buildSpawnEnv({
      ...process.env,
      HOME: CLAUDE_HOME,
      CLAUDE_PROJECT_DIR: CWD,
      CHAT_SESSION_DIR: sessionDir,
      DOCUMENTATOR_RUN: '1',
    }, null),
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  proc.stdout.on('data', (d) => { appendFile(logPath, d).catch(() => {}); });
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  // 'error' resolves the race separately — spawn ENOENT does NOT always emit
  // a subsequent 'close', so awaiting 'close' alone can hang forever.
  const spawnError = new Promise((resolve) => proc.once('error', resolve));
  const closePromise = new Promise((resolve) => proc.once('close', resolve));
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), DOCUMENTATOR_TIMEOUT_MS));

  const outcome = await Promise.race([
    closePromise.then((code) => ({ kind: 'close', code })),
    spawnError.then((err) => ({ kind: 'error', err })),
    timeoutPromise.then(() => ({ kind: 'timeout' })),
  ]);

  let exitCode;
  if (outcome.kind === 'close') {
    exitCode = outcome.code;
  } else if (outcome.kind === 'error') {
    stderrBuf += `\n${outcome.err?.message || outcome.err}`;
    exitCode = -1;
  } else {
    stderrBuf += `\nTimed out after ${DOCUMENTATOR_TIMEOUT_MS}ms`;
    try { proc.kill('SIGKILL'); } catch {}
    exitCode = -1;
  }
  if (exitCode !== 0 && stderrBuf) {
    await appendFile(logPath, `\nSTDERR:\n${stderrBuf}\n`).catch(() => {});
  }

  // Stamp the meta.json so the UI / debugging can see when the documentator
  // last ran for this session. Written here (not via session-store) because
  // the runtime/session object may already be closed by the time we get here.
  try {
    const metaPath = `${sessionDir}/meta.json`;
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    meta.documentatorLastRunAt = new Date().toISOString();
    meta.documentatorLastRunExit = exitCode;
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch {}

  return { exitCode, stderr: stderrBuf };
}
