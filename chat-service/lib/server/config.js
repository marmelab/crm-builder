import { join } from 'node:path';

export const PORT = Number(process.env.PORT) || 8080;
export const CWD = '/app';
export const CLAUDE_HOME = '/home/developer';
export const ORCHESTRATOR_MD = `${CLAUDE_HOME}/.claude/agents/chat-orchestrator.md`;
export const LOG_DIR = process.env.CHAT_LOG_DIR || '/chat-service/logs';

export const PROJECT_SLUG = CWD.replace(/\//g, '-');
export const PROJECT_DIR = join(CLAUDE_HOME, '.claude', 'projects', PROJECT_SLUG);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
};

export const ALLOWED_STATES = new Set(['in_progress', 'completed', 'cancelled', 'waiting']);

export const MODE_DEMO = 'demo';
export const MODE_FULL = 'full';
export const VALID_MODES = new Set([MODE_DEMO, MODE_FULL]);
