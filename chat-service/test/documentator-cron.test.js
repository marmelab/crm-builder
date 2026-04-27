import { test } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldSkipRun } from '../lib/documentator-cron.js';

async function makeTmpRoot() {
  const root = join(tmpdir(), `doctest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

test('shouldSkipRun returns false when last-run marker is missing', async () => {
  const root = await makeTmpRoot();
  const sessionsDir = join(root, 'logs');
  await mkdir(sessionsDir, { recursive: true });
  const result = await shouldSkipRun(join(root, 'last-run.txt'), sessionsDir);
  assert.strictEqual(result, false);
  await rm(root, { recursive: true, force: true });
});

test('shouldSkipRun returns true when no session log is newer than last-run', async () => {
  const root = await makeTmpRoot();
  const sessionsDir = join(root, 'logs');
  await mkdir(join(sessionsDir, 'sess-A'), { recursive: true });
  await writeFile(join(sessionsDir, 'sess-A', 'log.jsonl'), '');
  const old = new Date(Date.now() - 60_000);
  await utimes(join(sessionsDir, 'sess-A', 'log.jsonl'), old, old);
  const lastRunPath = join(root, 'last-run.txt');
  await writeFile(lastRunPath, new Date().toISOString());
  const result = await shouldSkipRun(lastRunPath, sessionsDir);
  assert.strictEqual(result, true);
  await rm(root, { recursive: true, force: true });
});

test('shouldSkipRun returns false when at least one session log is newer than last-run', async () => {
  const root = await makeTmpRoot();
  const sessionsDir = join(root, 'logs');
  await mkdir(join(sessionsDir, 'sess-A'), { recursive: true });
  const lastRunPath = join(root, 'last-run.txt');
  await writeFile(lastRunPath, 'old');
  const old = new Date(Date.now() - 60_000);
  await utimes(lastRunPath, old, old);
  await writeFile(join(sessionsDir, 'sess-A', 'log.jsonl'), '{}');
  const result = await shouldSkipRun(lastRunPath, sessionsDir);
  assert.strictEqual(result, false);
  await rm(root, { recursive: true, force: true });
});
