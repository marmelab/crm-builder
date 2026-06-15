import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('setClaudeSessionId(null) clears the persisted id', async () => {
  process.env.CHAT_LOG_DIR = await mkdtemp(join(tmpdir(), 'csid-'));
  const { openSession } = await import('../lib/server/session-store.js');
  const session = await openSession(null);
  await session.setClaudeSessionId('conv_abc');
  await session.setClaudeSessionId(null);
  const meta = JSON.parse(await readFile(join(process.env.CHAT_LOG_DIR, session.id, 'meta.json'), 'utf8'));
  assert.equal(meta.claudeSessionId, null);
  await session.close();
});
