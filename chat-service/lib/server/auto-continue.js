import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// --- Why this exists -------------------------------------------------------
// The no-team orchestrator drives a COMPLEX wave as an event-driven loop: it
// dispatches developers/reviewers/merger as background `Agent` calls and reacts
// to each completion. That works while it has work to interleave, but a single
// `claude -p` spawn ends on the SDK `result` event the moment the orchestrator
// goes idle — and nothing in chat-service re-invokes it on a background-agent
// completion (processMessage only fires on a user message or queue drain). So a
// wave that idles waiting on its last in-flight agent (e.g. the big ticket of a
// wave) stalls: the spawn wraps up, the agent finishes with no live query to
// react, and the remaining tickets stay pending forever.
//
// This module is the missing driver: after a turn settles `completed` with
// non-terminal tickets still on the board, chat-service auto-resumes the
// orchestrator (`claude --resume` with a synthetic nudge) so it picks the wave
// back up. Bounded by a hard cap and a no-progress guard so it can never loop
// or burn tokens indefinitely.

// Delay before auto-resuming. Long enough to let an agent that finished right
// at `result` get its commit on disk, and to debounce against a real user
// message (which cancels the timer). Under 5 min is irrelevant — a resume
// re-reads context regardless of prompt-cache TTL.
export const AUTO_CONTINUE_DELAY_MS = 8_000;

// Hard ceiling on consecutive auto-continues within one wave (reset by any real
// user message). A healthy wave drives tickets to terminal in far fewer; this
// is a runaway-cost backstop, not a normal limit.
export const MAX_AUTO_CONTINUE = 40;

// Stop auto-continuing if this many consecutive resumes leave the set of
// pending tickets byte-for-byte unchanged — i.e. resuming is no longer making
// progress (genuinely stuck), so further spawns would just burn tokens.
// Set high enough to outlast a slow developer agent (each cycle ≈ 30–60 s
// orchestrator RTT + 8 s delay, so 10 ≈ 6–10 min of patience before stalling).
export const MAX_NO_PROGRESS = 10;

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

// Pure decision: should chat-service auto-resume the orchestrator now?
// Inputs come from the just-settled turn + the per-wave auto-continue state.
// Returns { go, waveDone, stalled, noProgressCount } where:
//   go            — schedule an auto-resume
//   waveDone      — a real COMPLEX wave finished (all tickets terminal): the
//                   caller should run end-of-wave handling (documentator)
//   stalled       — 'cap' | 'no-progress': stop and surface a message
//   noProgressCount — updated consecutive no-progress counter to persist
export function decideAutoContinue({
  nextState,
  turnErrored,
  totalTickets,
  pendingCount,
  pendingSig,
  prevPendingSig,
  autoContinueCount,
  noProgressCount,
  maxAutoContinue = MAX_AUTO_CONTINUE,
  maxNoProgress = MAX_NO_PROGRESS,
}) {
  if (nextState !== 'completed' || turnErrored) return { go: false, waveDone: false };
  if (totalTickets === 0) return { go: false, waveDone: false };      // not a COMPLEX wave
  if (pendingCount === 0) return { go: false, waveDone: true };       // wave finished
  if (autoContinueCount >= maxAutoContinue) {
    return { go: false, waveDone: false, stalled: 'cap', noProgressCount };
  }
  const madeNoProgress = prevPendingSig != null && pendingSig === prevPendingSig;
  const nextNoProgress = madeNoProgress ? noProgressCount + 1 : 0;
  if (nextNoProgress >= maxNoProgress) {
    return { go: false, waveDone: false, stalled: 'no-progress', noProgressCount: nextNoProgress };
  }
  return { go: true, waveDone: false, noProgressCount: nextNoProgress };
}
