import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { ORCHESTRATOR_MD } from './config.js';

// Only the orchestrator MODEL is consumed from the agent file — the routing system
// prompt itself is loaded by the Claude CLI via `--agent orchestrator` inside
// PtySession, not injected by chat-service. The documentator is dispatched via the
// Agent tool (Claude Code loads documentator.md directly), so chat-service no
// longer needs to read or hold its prompt.
//
// The orchestrator is the surface-agnostic routing agent; the non-technical
// web-chat persona (language, cartouches, demo/full data-mode) + the top-level
// interactive surface declaration live in web-chat-surface.md and are injected via
// --append-system-prompt. getWebChatSurface() reads it once and caches it.
let orchestratorModel = null;
let webChatSurface = null;

async function parseAgentFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const model = fm?.[1].match(/^model:\s*(\S+)/m)?.[1] || null;
    const content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    return { content, model };
  } catch {
    return { content: '', model: null };
  }
}

export async function loadSystemPrompt() {
  return parseAgentFile(ORCHESTRATOR_MD);
}

export function applySystemPrompt({ model }) {
  orchestratorModel = model || null;
}

export function getOrchestratorModel() { return orchestratorModel; }

// The web-chat persona + surface declaration, appended to the orchestrator's
// system prompt at spawn. Read once and cached. Empty string on failure → the
// orchestrator still runs (bare, technical), so a missing file degrades rather
// than crashes the spawn.
export function getWebChatSurface() {
  if (webChatSurface == null) {
    try {
      webChatSurface = readFileSync(
        new URL('../../prompts/web-chat-surface.md', import.meta.url),
        'utf8',
      ).trim();
    } catch {
      webChatSurface = '';
    }
  }
  return webChatSurface;
}
