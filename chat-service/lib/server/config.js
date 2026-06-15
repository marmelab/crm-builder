import { join } from 'node:path';

export const PORT = Number(process.env.PORT) || 8080;
export const CWD = '/app';
export const CLAUDE_HOME = '/home/developer';
export const ORCHESTRATOR_MD = `${CLAUDE_HOME}/.claude/agents/chat-orchestrator.md`;
export const LOG_DIR = process.env.CHAT_LOG_DIR || '/chat-service/logs';

// Live Claude CLI workspace layout under $HOME/.claude/projects/<slug>/<csid>/.
// The slug is CWD with slashes flipped to dashes (Claude CLI convention) — the
// chat-service, the subagent tailer, and the stats post-processor all need
// these paths, so they live here.
const CLAUDE_PROJECT_SLUG = CWD.replace(/\//g, '-');
export const claudeProjectDir = () =>
  join(CLAUDE_HOME, '.claude', 'projects', CLAUDE_PROJECT_SLUG);
export const claudeSessionDir = (csid) => join(claudeProjectDir(), csid);
export const claudeSubagentsDir = (csid) => join(claudeSessionDir(csid), 'subagents');

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
};

export const ALLOWED_STATES = new Set(['in_progress', 'completed', 'cancelled', 'waiting', 'rate_limited', 'error']);

export const MODE_DEMO = 'demo';
export const MODE_FULL = 'full';
export const VALID_MODES = new Set([MODE_DEMO, MODE_FULL]);
