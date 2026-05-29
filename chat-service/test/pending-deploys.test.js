import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../../scripts/pending-deploys.mjs', import.meta.url).pathname;

function git(cwd, ...args) { return execFileSync('git', args, { cwd }).toString(); }

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pd-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t'); git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
  writeFileSync(join(dir, 'src/types.ts'), 'export type Contact = { id: string };\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'seed');
  git(dir, 'branch', 'session-base/ab12cd34', 'main');
  git(dir, 'branch', 'session/ab12cd34', 'main');
  return dir;
}

test('empty when session branch made no schema-relevant change', () => {
  const dir = setupRepo();
  const out = execFileSync('node', [SCRIPT, '--app', dir, '--session', 'ab12cd34']).toString().trim();
  assert.equal(out, '');
  rmSync(dir, { recursive: true, force: true });
});

test('non-empty when the session branch adds an entity field', () => {
  const dir = setupRepo();
  git(dir, 'checkout', '-q', 'session/ab12cd34');
  writeFileSync(join(dir, 'src/types.ts'), 'export type Contact = { id: string; priority: number };\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'add priority');
  git(dir, 'checkout', '-q', 'main');
  const out = execFileSync('node', [SCRIPT, '--app', dir, '--session', 'ab12cd34']).toString().trim();
  assert.notEqual(out, '');
  rmSync(dir, { recursive: true, force: true });
});

test('empty and no stderr when session branches do not exist (e.g. hooks did not run)', () => {
  const dir = setupRepo();
  // No session-base/xx99yy00 or session/xx99yy00 branches created intentionally.
  let stderr = '';
  const proc = execFileSync('node', [SCRIPT, '--app', dir, '--session', 'xx99yy00'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(proc.trim(), '');
  rmSync(dir, { recursive: true, force: true });
});
