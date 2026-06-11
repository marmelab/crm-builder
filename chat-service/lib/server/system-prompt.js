import { readFile } from 'node:fs/promises';
import { ORCHESTRATOR_MD } from './config.js';

// Only the orchestrator MODEL is consumed from the agent file — the system prompt
// itself is loaded by the Claude CLI via `--agent chat-orchestrator` inside
// PtySession, not injected by chat-service. The documentator is dispatched via the
// Agent tool (Claude Code loads documentator.md directly), so chat-service no
// longer needs to read or hold its prompt.
let orchestratorModel = null;

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
