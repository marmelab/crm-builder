import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// --- Why this exists -------------------------------------------------------
// This module provides two things that turn.js needs for the heartbeat-driven
// auto-continue loop (see `startBgDriver` in turn.js):
//
//   readTicketStatuses(sessionDir)
//     Reads TASK-<n>.json files from the session directory and returns
//     { total, pendingCount, pendingSig } so the heartbeat can decide
//     whether the orchestrator still has work to do.
//
//   AUTO_CONTINUE_NUDGE
//     The synthetic user message injected when the heartbeat resumes the
//     orchestrator via processMessage({ auto: true }).
//
// The actual "should we resume?" decision logic and the scheduling loop live
// in turn.js (startBgDriver / the inactivity watchdog), not here.

const TERMINAL_STATUSES = new Set(['merged', 'failed']);

// The synthetic user message used to resume the orchestrator. Mirrors what a
// human "continue" would convey, in STATE B terms.
export const AUTO_CONTINUE_NUDGE = [
  '[auto-continue] Background agents have completed since your last turn, but the wave is not finished.',
  'Re-read the ticket files in TICKETS_DIR and your STATE B mental state, then continue:',
  '- for any ticket whose developer returned DONE, dispatch its quality-reviewer + test-validator;',
  '- for any ticket whose reviewers both APPROVED, dispatch its merger;',
  '- once every ticket of a wave is terminal, dispatch the next wave;',
  '- once every planner ticket is merged or failed, run the end-of-wave promotion and finish.',
  'Do NOT re-dispatch or re-merge work that is already merged. Resume now.',
].join('\n');

// Reads TASK-<n>.json statuses from the session dir.
//   total       — number of planner ticket files
//   pendingCount — tickets whose status is not merged/failed
//   pendingSig   — stable signature of the pending set (id:status, sorted),
//                  used to detect "no progress between two resumes"
export async function readTicketStatuses(sessionDir) {
  let entries;
  try {
    entries = await readdir(sessionDir);
  } catch {
    return { total: 0, pendingCount: 0, pendingSig: '' };
  }
  const pending = [];
  let total = 0;
  for (const entry of entries) {
    if (!/^TASK-\d+\.json$/i.test(entry)) continue;
    total += 1;
    let status = 'unknown';
    try {
      const ticket = JSON.parse(await readFile(join(sessionDir, entry), 'utf8'));
      if (typeof ticket?.status === 'string') status = ticket.status;
    } catch {}
    if (!TERMINAL_STATUSES.has(status)) pending.push(`${entry.replace(/\.json$/i, '')}:${status}`);
  }
  pending.sort();
  return { total, pendingCount: pending.length, pendingSig: pending.join(',') };
}
