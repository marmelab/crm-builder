import { isAuthErrorStderr, isNetworkErrorStderr } from './turn-state.js';

// Exported for unit testing
export function extractText(msg) {
  if (msg.type !== 'assistant') return null;
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text.trim() ? text : null;
}

export function extractToolUses(msg) {
  if (msg.type !== 'assistant') return [];
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b.type === 'tool_use');
}

// Explicit `<intent>…</intent>` markers the orchestrator classifies on (see the
// CLASSIFICATION table in orchestrator.md — these literals MUST match the
// markers that table keys on). Kept as constants so the two builders below and
// the prompt stay in lockstep.
export const INTENT_SETUP = '<intent>setup</intent>';
export const INTENT_RECOVERY = '<intent>recovery</intent>';

// The chat UI's "Define your business" button sends `content: 'FULL_SETUP'`.
// We rewrite it into the INTENT_SETUP marker the orchestrator recognises
// (cohérent with `<mode>` / `<session_dir>` env tags). Plain-text fallback is
// kept so any NL detection in the orchestrator still has something to chew on.
export function rewriteUserMessage(userMessage) {
  if (userMessage === 'FULL_SETUP') {
    return `${INTENT_SETUP}\nUser clicked "Define your business" — start the project setup interview.`;
  }
  return userMessage;
}

// Replayed (instead of the verbatim request) when a resume must rebuild from
// scratch — i.e. the previous run was interrupted (a crash OR a usage limit)
// while a COMPLEX wave was in flight. The killed process and every team/agent/
// subagent it spawned are gone, but its CLI transcript still ends on "team
// dispatched, work in progress". Resuming that transcript (--resume) reinjects
// that stale belief, so replaying the original request reads as user impatience
// → the orchestrator no-ops with "already in progress" while nothing actually
// runs. This directive instead carries only the INTENT_RECOVERY marker (which
// routes to STATE RECOVERY in the orchestrator, spawned FRESH with no --resume)
// plus the original request for context. The procedure and constraints —
// "assume nothing survived, rebuild from disk, never say already-in-progress" —
// live solely in STATE RECOVERY (orchestrator.md) to avoid drift.
export function buildRecoveryPrompt(originalMessage) {
  return [
    INTENT_RECOVERY,
    'The previous run was interrupted; follow STATE RECOVERY.',
    '',
    'Original request (for context):',
    originalMessage,
  ].join('\n');
}

// Decide how a resume re-enters the turn loop. A crash or a usage limit both
// kill the orchestrator process and every subagent it dispatched, so the
// distinguishing signal is NOT error-vs-rate_limited but whether a COMPLEX wave
// was actually in flight (hasDispatchedWork — ticket files on disk):
//   - process killed WITH a wave in flight → the transcript's "team is running"
//     belief is now false. Spawn a FRESH session (freshSession) with a recovery
//     directive so that misleading context isn't reinjected via --resume.
//   - otherwise (interview, SIMPLE, plain Q&A, or limit hit before any dispatch)
//     → a plain --resume legitimately preserves the conversation and continues.
export function planResume(state, message, hasDispatchedWork) {
  const processKilled = state === 'error' || state === 'rate_limited';
  if (processKilled && hasDispatchedWork) {
    return { prompt: buildRecoveryPrompt(message), freshSession: true };
  }
  return { prompt: message, freshSession: false };
}

// NB: neither the orchestrator nor session titling is spawned headless
// (`claude -p`) anymore. The orchestrator runs as a persistent interactive TUI
// (PtySession); the session title is emitted by the orchestrator itself via a
// <session-title>…</session-title> tag, parsed in turn.js. The former
// spawnClaude() and regenerateTitleWithHaiku() were removed with that migration.

export function friendlyError({ exitCode, stderr, rateLimit, resultError }) {
  if (rateLimit) {
    // Prefer the CLI's own user-facing text when present (the synthetic
    // rate-limit message already reads "You've hit your session limit · resets
    // <time>"); fall back to a computed countdown, then a generic limit line.
    if (rateLimit.message) return rateLimit.message;
    if (rateLimit.resetsAt) {
      const minutes = Math.max(1, Math.ceil((rateLimit.resetsAt * 1000 - Date.now()) / 60000));
      return `Usage limit reached. You can try again in about ${minutes} minute(s).`;
    }
    return "Usage limit reached. Please try again shortly.";
  }
  if (isAuthErrorStderr(stderr)) {
    return "Access has expired. Please contact your administrator to renew the session.";
  }
  if (isNetworkErrorStderr(stderr)) {
    return "Unable to reach the service right now. Check your connection and try again.";
  }
  if (resultError) {
    return "Something went wrong while processing your request. Want to try again?";
  }
  if (exitCode !== 0) {
    return "An unexpected error occurred. Want to try again?";
  }
  return "I couldn't complete your request. Could you rephrase it?";
}
