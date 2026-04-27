import { stat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
