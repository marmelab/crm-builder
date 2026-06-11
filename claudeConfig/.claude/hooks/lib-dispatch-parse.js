#!/usr/bin/env node
// claudeConfig/.claude/hooks/lib-dispatch-parse.js
// Canonical parser for PreToolUse/Agent hook stdin. Reads the hook JSON on
// stdin, extracts the dispatch-prompt KEY: value contract (chat-orchestrator.md
// STATE B templates), prints shell-eval'able KEY="value" lines. Every Agent
// hook sources this output — the contract regexes live in exactly one place.
//
// TASK_ID is anchored at line start and only accepts TASK-<n> | SIMPLE |
// PROMOTE | ROLLBACK, so prose mentioning another ticket (e.g. "TASK-001 is
// merged; now ...") can never mis-key the gate. AGENT_TYPE mirrors the caller
// identity the hook payload carries: input.agent_type is "" for the main
// orchestrator and the agent's own type for a subagent-issued dispatch.
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const ti = input.tool_input || {};
  const p = String(ti.prompt || '');
  const grab = (re) => (p.match(re) || [, ''])[1];
  const out = {
    HOOK_SESSION_ID: input.session_id || '',
    AGENT_TYPE: input.agent_type || '',
    SUBAGENT_TYPE: ti.subagent_type || '',
    AGENT_NAME: ti.name || '',
    ISOLATION: ti.isolation || '',
    RUN_IN_BACKGROUND: ti.run_in_background ? '1' : '',
    ROLE: grab(/^ROLE:\s*(\S+)/m),
    TASK_ID: grab(/^TASK_ID:\s*(TASK-\d+|SIMPLE|PROMOTE|ROLLBACK)\b/m),
    WORKTREE_PATH: grab(/^WORKTREE_PATH:\s*(\S+)/m),
    BRANCH_NAME: grab(/^BRANCH_NAME:\s*(\S+)/m),
    MODE: grab(/^MODE:\s*(\S+)/m),
    SESSION_SHORT_ID: grab(/^SESSION_SHORT_ID:\s*(\S+)/m),
    TICKET_FILE: grab(/^TICKET_FILE:\s*(\S+)/m),
    TICKETS_DIR: grab(/^TICKETS_DIR:\s*(\S+)/m),
  };
  // Single-quote for bash: wrap in '...' and escape embedded ' as '\'' .
  // eval-safe — values are prompt-derived and must never be command-substituted.
  // (JSON.stringify produces DOUBLE quotes, inside which bash still performs
  // $(...) / backtick expansion at eval time — a command-injection vector.)
  const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  for (const [k, v] of Object.entries(out)) {
    process.stdout.write(`${k}=${shq(v)}\n`);
  }
});
