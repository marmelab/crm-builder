import { readFile, readdir } from 'fs/promises';
import { LOG_DIR } from './config.js';
import { broadcast } from './ws-bus.js';

// Tickets live in the session folder (alongside log.jsonl / meta.json) since
// the TICKETS_DIR refactor — see chat-orchestrator.md. Progress is scoped to
// the current turn: tickets present at spawn-start are baselined out so the
// counter doesn't leak prior-turn work into a fresh prompt.
export const TICKET_FILE_RE = /^TASK-.*\.json$/;

export async function snapshotTickets(sessionDir) {
  try {
    const entries = await readdir(sessionDir);
    return new Set(entries.filter((f) => TICKET_FILE_RE.test(f)));
  } catch {
    return new Set();
  }
}

export async function computeProgress(sessionDir, baseline = new Set()) {
  let entries;
  try { entries = await readdir(sessionDir); } catch { return { total: 0, done: 0 }; }
  const files = entries.filter((f) => TICKET_FILE_RE.test(f) && !baseline.has(f));
  if (files.length === 0) return { total: 0, done: 0 };
  let done = 0;
  for (const file of files) {
    try {
      const j = JSON.parse(await readFile(`${sessionDir}/${file}`, 'utf8'));
      if (j?.status === 'merged') done++;
    } catch {}
  }
  return { total: files.length, done };
}

export async function sendProgress(runtime) {
  if (!runtime?.session) return;
  const baseline = runtime.turnTicketBaseline || new Set();
  const { total, done } = await computeProgress(`${LOG_DIR}/${runtime.session.id}`, baseline);
  broadcast(runtime, { type: 'progress', total, done });
}
