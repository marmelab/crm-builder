import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptWatcher } from '../lib/server/transcript-watcher.js';

// Helper: wait for an event with timeout
function waitForEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

test('TranscriptWatcher: emits session_id when new .jsonl appears in dir', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const watcher = new TranscriptWatcher(null, dir);
  const eventPromise = waitForEvent(watcher, 'event');
  await watcher.start();
  await new Promise(r => setTimeout(r, 50)); // wait for fs.watch to attach

  // Simulate Claude creating its session file
  const sessionId = 'abc123-test-session-id';
  await writeFile(join(dir, `${sessionId}.jsonl`), '');

  const ev = await eventPromise;
  assert.equal(ev.session_id, sessionId);

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: emits assistant event when new line appended to watched file', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'def456-test-session';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const eventPromise = waitForEvent(watcher, 'event');

  const assistantEntry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    uuid: 'u1',
    sessionId,
  };
  await appendFile(jsonlPath, JSON.stringify(assistantEntry) + '\n');

  const ev = await eventPromise;
  assert.equal(ev.type, 'assistant');
  assert.equal(ev.message.content[0].text, 'Hello!');

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: skips existing lines on resume, only emits new ones', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'ghi789-resume';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);

  // Pre-existing content (old turn)
  const oldEntry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Old message' }] },
    uuid: 'old', sessionId,
  };
  await writeFile(jsonlPath, JSON.stringify(oldEntry) + '\n');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();  // should seek to end, skip old entry

  const events = [];
  watcher.on('event', e => events.push(e));

  // Append new content
  const newEntry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'New message' }] },
    uuid: 'new', sessionId,
  };
  await appendFile(jsonlPath, JSON.stringify(newEntry) + '\n');

  // Wait for the event to fire (event-based, not fixed sleep)
  const ev = await waitForEvent(watcher, 'event');
  assert.equal(events.length, 1, 'should emit only the new entry, not the old one');
  assert.equal(ev.message.content[0].text, 'New message');

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: ignores non-assistant JSONL entries', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'jkl012-filter';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const events = [];
  watcher.on('event', e => events.push(e));

  const userEntry = { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u2', sessionId };
  await appendFile(jsonlPath, JSON.stringify(userEntry) + '\n');
  await new Promise(r => setTimeout(r, 500));

  assert.equal(events.length, 0, 'should not emit user entries');

  watcher.close();
  await rm(dir, { recursive: true });
});
