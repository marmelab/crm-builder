export const PORT = Number(process.env.PORT) || 8080;
export const CWD = '/app';
export const CLAUDE_HOME = '/home/developer';
export const ORCHESTRATOR_MD = `${CLAUDE_HOME}/.claude/agents/chat-orchestrator.md`;
export const LOG_DIR = process.env.CHAT_LOG_DIR || '/chat-service/logs';
export const HOOKS_LOG_PATH = `${LOG_DIR}/hooks.log`;

export const WELCOME_CHOICES = {
  type: 'choices',
  content: 'Hello! How can I help you today?',
  options: [
    { id: 'FULL_SETUP', label: '🗺️  Set up my CRM from scratch', sublabel: 'Interview to understand your business and build a complete plan' },
    { id: 'QUICK_EDIT', label: '⚡ Make a quick change',          sublabel: 'Describe what you want to add or modify' },
  ],
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
};

export const ALLOWED_STATES = new Set(['in_progress', 'completed', 'cancelled', 'waiting']);
