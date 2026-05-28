#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  pending-deploys — List ticket ids that still need a
//  Supabase deploy, by combining the per-ticket
//  `requires_supabase_migration` + `status` fields with the
//  orchestrator's `.deploy-applied` ledger.
//
//  Usage:
//    pending-deploys <TICKETS_DIR>
//
//  Prints one TASK-XXX id per line, on stdout. Prints nothing
//  when there are no pending tickets. Exit code is always 0
//  (an empty list is a valid result, not an error).
// ─────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('TICKETS_DIR argument required\n');
  process.exit(1);
}
if (!existsSync(dir)) process.exit(0);

const applied = new Set();
try {
  readFileSync(join(dir, '.deploy-applied'), 'utf8')
    .split('\n').filter(Boolean).forEach((t) => applied.add(t.trim()));
} catch {}

const pending = [];
// Accept the two canonical ticket shapes only: COMPLEX (`TASK-<digits>`) and
// SIMPLE pseudo-tickets (`TASK-SIMPLE-<6 hex>`). A looser pattern would match
// hand-edited or malformed files in TICKETS_DIR.
const TICKET_FILE_RE = /^TASK-(\d+|SIMPLE-[A-Za-z0-9]+)\.json$/;
for (const f of readdirSync(dir).filter((x) => TICKET_FILE_RE.test(x))) {
  try {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (j.status === 'merged'
        && j.requires_supabase_migration === true
        && !applied.has(j.ticket_id)) {
      pending.push(j.ticket_id);
    }
  } catch {}
}
if (pending.length) console.log(pending.join('\n'));
