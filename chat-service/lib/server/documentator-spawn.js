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
  proc.once('error', (err) => { stderrBuf += `\n${err?.message || err}`; });

  const exitCode = await new Promise((resolve) => proc.once('close', resolve));
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
