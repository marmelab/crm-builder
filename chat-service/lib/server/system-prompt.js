import { readFile } from 'node:fs/promises';
import { ORCHESTRATOR_MD, DOCUMENTATOR_MD } from './config.js';

// Only the MODEL is consumed from the orchestrator agent file now — the system
// prompt itself is loaded by the Claude CLI via `--agent chat-orchestrator`
// inside PtySession, not injected by chat-service. The documentator (`claude -p`)
// still needs its prompt body + model.
let orchestratorModel = null;

let documentatorPrompt = '';
let documentatorModel = null;

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

export async function loadDocumentatorPrompt() {
  return parseAgentFile(DOCUMENTATOR_MD);
}

export function applyDocumentatorPrompt({ content, model }) {
  documentatorPrompt = content || '';
  documentatorModel = model || null;
}

export function getDocumentatorPrompt() { return documentatorPrompt; }
export function getDocumentatorModel() { return documentatorModel; }
