#!/usr/bin/env node
// pending-deploys — decide whether the session has schema-relevant changes
// not yet covered by supabase/migrations/.
//
//   pending-deploys --app <APP_DIR> --session <SESSION_SHORT>
//
// Prints a non-empty marker (the changed schema-relevant paths) when a deploy
// is worth offering; prints nothing otherwise. Exit code always 0.
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const APP = get('--app', '/app');
const SESSION = get('--session', '');
if (!SESSION) { process.stderr.write('--session <SESSION_SHORT> required\n'); process.exit(0); }

// Schema-relevant path heuristic: entity types, fake-data generators, resource
// registrations, and SQL schema files modified by simple-developer.
// Anchored to avoid matching arbitrary paths with "fake" substrings.
const SCHEMA_RE = /(\/types?\.ts$|dataProvider|\/dataGenerator\/|supabase\/schemas\/|resources?\/.*\.(ts|tsx)$)/i;

let changed = '';
try {
  changed = execFileSync('git', [
    '-C', APP, 'diff', '--name-only',
    `session-base/${SESSION}..session/${SESSION}`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
} catch { process.exit(0); }

const relevant = changed.split('\n').filter(Boolean).filter((p) => SCHEMA_RE.test(p));
// (Idempotency against already-applied schema is enforced later by the
// migration round, which cross-checks supabase/migrations/ and may no-op.)
if (relevant.length) console.log(relevant.join('\n'));
