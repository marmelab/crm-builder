import { spawn } from 'node:child_process';
import { stat, readdir, readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import cron from 'node-cron';

/**
 * @param {string} lastRunPath  Path to the last-run marker file (mtime is used).
 * @param {string} sessionsDir  Path to /chat-service/logs/ (one subdir per session).
 * @returns {Promise<boolean>}  true → no new activity, skip the run.
 */
export async function shouldSkipRun(lastRunPath, sessionsDir) {
  let lastRunMtime;
  try {
    const s = await stat(lastRunPath);
    lastRunMtime = s.mtime;
  } catch {
    return false;
  }

  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const logStat = await stat(join(sessionsDir, entry.name, 'log.jsonl'));
      if (logStat.mtime > lastRunMtime) return false;
    } catch {
      continue;
    }
  }
  return true;
}

/**
 * Reads a Claude agent markdown file (frontmatter + prose) and returns the
 * model identifier from frontmatter and the body text. Mirrors the
 * loadSystemPrompt() function in server.js.
 *
 * @param {string} agentMdPath
 * @returns {Promise<{ content: string, model: string|null }>}
 */
export async function loadDocumentatorPrompt(agentMdPath) {
  try {
    const raw = await readFile(agentMdPath, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const model = fm?.[1].match(/^model:\s*(\S+)/m)?.[1] || null;
    const content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    return { content, model };
  } catch {
    return { content: '', model: null };
  }
}

/**
 * Spawns a one-shot claude process running the documentator agent. Streams
 * stdout into the daily audit file. Updates the last-run marker on completion.
 *
 * @param {object} opts
 * @param {string} opts.sessionsDir   e.g. /chat-service/logs
 * @param {string} opts.lastRunPath   e.g. /app/docs/learnings/runs/last-run.txt
 * @param {string} opts.runsDir       e.g. /app/docs/learnings/runs
 * @param {string} opts.agentMdPath   path to documentator.md
 * @param {string} opts.claudeHome    HOME for the spawned claude process
 * @param {string} opts.cwd           cwd for the spawned claude process
 * @returns {Promise<{ skipped: boolean, exitCode?: number, auditPath?: string }>}
 */
export async function runDocumentator(opts) {
  const { sessionsDir, lastRunPath, runsDir, agentMdPath, claudeHome, cwd } = opts;
  if (await shouldSkipRun(lastRunPath, sessionsDir)) {
    return { skipped: true };
  }

  const { content: systemPrompt, model } = await loadDocumentatorPrompt(agentMdPath);
  if (!systemPrompt) {
    throw new Error(`documentator agent prompt missing or unreadable at ${agentMdPath}`);
  }

  await mkdir(runsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const auditPath = `${runsDir}/${today}-run.md`;

  const userMessage =
    `Run a documentator pass. Read the 5 sources described in your instructions, ` +
    `match each new event against the existing entries in docs/learnings/patterns.md, ` +
    `amend that file accordingly. Output a short summary of what you did.`;
  const prompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userMessage}`;

  const args = ['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  args.push('-p', prompt);

  const proc = spawn('claude', args, {
    env: { ...process.env, HOME: claudeHome, DOCUMENTATOR_RUN: '1' },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await appendFile(auditPath, `# Documentator run — ${new Date().toISOString()}\n\n## stream\n\n`);
  const audit = createWriteStream(auditPath, { flags: 'a' });
  proc.stdout.pipe(audit, { end: false });
  proc.stderr.on('data', (d) => audit.write(`[stderr] ${d}`));

  const exitCode = await new Promise((resolve) => {
    proc.once('close', resolve);
    proc.once('error', (err) => {
      audit.write(`\n[spawn-error] ${err.message}\n`);
      resolve(-1);
    });
  });
  audit.end();

  await writeFile(lastRunPath, new Date().toISOString());
  return { skipped: false, exitCode, auditPath };
}

/**
 * Registers a daily cron at 03:00 local time that calls runDocumentator.
 * Returns the ScheduledTask so callers can stop it in tests.
 */
export function scheduleDocumentator(opts) {
  return cron.schedule('0 3 * * *', async () => {
    try {
      const result = await runDocumentator(opts);
      console.log('[documentator]', result.skipped ? 'skipped (no activity)' : `ran exit=${result.exitCode}`);
    } catch (err) {
      console.error('[documentator] run failed:', err.message);
    }
  });
}
