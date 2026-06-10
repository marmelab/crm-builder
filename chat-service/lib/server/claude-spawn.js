import { spawn } from 'node:child_process';
import { CWD, CLAUDE_HOME, MODE_DEMO } from './config.js';
import { getSystemPrompt, getOrchestratorModel } from './system-prompt.js';
import { broadcast } from './ws-bus.js';
import { readMessages } from './session-store.js';
import { buildSpawnEnv } from '../spawn-env.js';
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
// CLASSIFICATION table in chat-orchestrator.md — these literals MUST match the
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
// live solely in STATE RECOVERY (chat-orchestrator.md) to avoid drift.
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

export function spawnClaude(userMessage, claudeSessionId, sessionDir) {
  const mode = process.env.MODE || MODE_DEMO;
  const env = `<mode>${mode}</mode>\n<session_dir>${sessionDir}</session_dir>`;
  const systemPrompt = getSystemPrompt();
  const orchestratorModel = getOrchestratorModel();
  const finalUserMessage = rewriteUserMessage(userMessage);
  const prompt = systemPrompt
    ? `<instructions>\n${systemPrompt}\n</instructions>\n\n${env}\n\n${finalUserMessage}`
    : `${env}\n\n${finalUserMessage}`;
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    // The orchestrator never calls MCP tools directly — it routes via Agent/Teams.
    // Loading 13+ claude.ai "needs-auth" servers wastes ~8K tokens per spawn.
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
  if (orchestratorModel) args.push('--model', orchestratorModel);
  if (claudeSessionId) args.push('--resume', claudeSessionId);
  args.push('-p', prompt);
  const baseEnv = {
    ...process.env,
    HOME: CLAUDE_HOME,
    CLAUDE_PROJECT_DIR: CWD,
    CHAT_SESSION_DIR: sessionDir,
    MODE: mode,
  };
  return spawn('claude', args, {
    env: buildSpawnEnv(baseEnv, claudeSessionId),
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Runs a one-shot Haiku call to regenerate the session title. Invoked when
// the user sends their 1st message so the label reflects what the chat is
// actually about (the initial auto-title is a crude first-message slice).
export async function regenerateTitleWithHaiku(runtime) {
  const session = runtime?.session;
  if (!session) return;
  const m = session.meta;
  if (m.titleLocked || m.titleAutoGenerated) return;

  const msgs = await readMessages(session.id);
  if (msgs.length < 1) return;

  // Send the first few exchanges — more than that dilutes the signal.
  const convo = msgs.slice(0, 6)
    .map((x) => `${x.role === 'user' ? 'User' : 'Assistant'}: ${x.content}`)
    .join('\n\n');
  const prompt =
    `Based on the conversation below, generate a concise title (3 to 6 words, ` +
    `same language as the user, no punctuation, no quotes, no emoji). ` +
    `Reply with ONLY the title, nothing else.\n\n${convo}`;

  const proc = spawn('claude', [
    '--model', 'claude-haiku-4-5',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ], {
    env: { ...process.env, HOME: CLAUDE_HOME },
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.once('error', () => {}); // Don't crash if claude isn't on PATH.

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const exitCode = await new Promise((resolve) => proc.once('close', resolve))
    .catch(() => -1);
  if (exitCode !== 0) {
    if (err) console.error('[haiku-title]', err.trim());
    return;
  }

  const title = out.trim().split('\n')[0]
    .replace(/^["'`«]+|["'`»]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
  if (!title) return;

  // Re-check the flag — the user could have renamed while Haiku was running.
  if (session.meta.titleLocked) return;
  await session.setTitle(title, { auto: true });
  broadcast(runtime, { type: 'title', title });
}

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
