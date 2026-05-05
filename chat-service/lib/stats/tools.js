// Tool-use detail formatting + SendMessage verdict classification. Used by
// the children-population pass to render compact "what did this tool do"
// strings and to colour-code reviewer/dev exchanges in the timeline.

export function toolDetail(toolName, input) {
  if (!input) return null;
  const short = (s, n = 80) => (typeof s === 'string' && s.length > n) ? '…' + s.slice(-n) : s;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': return short(input.file_path);
    case 'Bash': return short(input.command, 80);
    case 'Grep': return `"${input.pattern ?? ''}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob': return input.pattern ?? null;
    case 'Skill': return input.skill ?? null;
    case 'Agent':
    case 'Task': return `${input.subagent_type || '?'}: ${(input.description || '').slice(0, 70)}`;
    case 'TeamCreate': return `team=${input.team_name || '?'}`;
    case 'TeamDelete': return `team=${input.team_name || '?'}`;
    case 'SendMessage': return sendMessageDetail(input);
    default: return null;
  }
}

// Classify a SendMessage's semantic intent. Used both for the icon prefix in
// the detail string AND as a separate `verdict` field on the child so the
// renderer can colour-code rows (red BLOCKED, orange AWR, etc.).
export function sendMessageVerdict(text) {
  if (/shutdown_request/i.test(text)) return 'shutdown';
  // Order matters: AWR before plain APPROVED.
  if (/^APPROVED\s+WITH\s+RESERVATIONS\b/i.test(text)) return 'awr';
  if (/^APPROVED\b/i.test(text)) return 'approved';
  if (/^BLOCKED\b/i.test(text) || /^RED\b/i.test(text)) return 'blocked';
  if (/^GREEN\b/i.test(text)) return 'approved';
  if (/\bready\b.*\b(review|validate|merge)\b/i.test(text) || /^GO\b/.test(text)) return 'ready';
  if (/^merged\s+TASK-/i.test(text) || /merge\s+failed/i.test(text)) return 'merger-report';
  return null;
}

const VERDICT_ICON = {
  shutdown: '🛑', awr: '🟡', approved: '✅', blocked: '❌',
  ready: '📨', 'merger-report': '🔀',
};

export function sendMessageDetail(input) {
  const to = input.to || '?';
  const raw = input.message;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '');
  const head = text.slice(0, 60);
  const verdict = sendMessageVerdict(text);
  const tag = verdict ? VERDICT_ICON[verdict] : '';
  return `${tag ? tag + ' ' : ''}→ ${to}${head ? ' :: ' + head : ''}`;
}

export function sendMessageVerdictFromInput(input) {
  const raw = input?.message;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '');
  return sendMessageVerdict(text);
}
