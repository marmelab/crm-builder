// Snapshot a Claude session's transcript + subagent files into the chat
// session's log dir, so /api/stats can read them after ~/.claude is recycled.
import { cp, copyFile, mkdir, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_DIR, claudeProjectDir, claudeSessionDir } from './config.js';

export async function snapshotClaudeSession(claudeSessionId, sessionId) {
  if (!claudeSessionId || !sessionId) return;
  const srcDir = claudeSessionDir(claudeSessionId);
  const destDir = join(LOG_DIR, sessionId, 'claude');

  await mkdir(destDir, { recursive: true });
  await copyFile(join(claudeProjectDir(), `${claudeSessionId}.jsonl`), join(destDir, 'transcript.jsonl'))
    .then(() => chmod(join(destDir, 'transcript.jsonl'), 0o644))
    .catch(() => {});
  for (const subdir of ['subagents', 'tool-results']) {
    const src = join(srcDir, subdir);
    const dst = join(destDir, subdir);
    await cp(src, dst, { recursive: true })
      .then(() => chmodDir(dst, 0o644, 0o755))
      .catch(() => {});
  }
}

async function chmodDir(dir, fileMode, dirMode) {
  await chmod(dir, dirMode).catch(() => {});
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await chmodDir(full, fileMode, dirMode);
    else await chmod(full, fileMode).catch(() => {});
  }
}
