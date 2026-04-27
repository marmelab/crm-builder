import { stat, readdir } from 'node:fs/promises';
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
