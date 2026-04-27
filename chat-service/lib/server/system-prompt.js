import { readFile } from 'fs/promises';
import { ORCHESTRATOR_MD } from './config.js';

let systemPrompt = '';
let orchestratorModel = null;
let orchestratorTools = null;

export async function loadSystemPrompt() {
  try {
    const raw = await readFile(ORCHESTRATOR_MD, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const model = fm?.[1].match(/^model:\s*(\S+)/m)?.[1] || null;
    const toolsBlock = fm?.[1].match(/^tools:\n((?:[ \t]+-\s+\S+\n?)+)/m)?.[1];
    const tools = toolsBlock
      ? toolsBlock.split('\n').map((l) => l.replace(/^[ \t]+-\s+/, '').trim()).filter(Boolean)
      : null;
    const content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    return { content, model, tools };
  } catch {
    return { content: '', model: null, tools: null };
  }
}

export function applySystemPrompt({ content, model, tools }) {
  systemPrompt = content || '';
  orchestratorModel = model || null;
  orchestratorTools = tools || null;
}

export function getSystemPrompt() { return systemPrompt; }
export function getOrchestratorModel() { return orchestratorModel; }
export function getOrchestratorTools() { return orchestratorTools; }
