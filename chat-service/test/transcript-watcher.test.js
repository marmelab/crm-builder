import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptWatcher, classifyToolResult, parseTaskNotification } from '../lib/server/transcript-watcher.js';

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

  // Simulate Claude creating its session file.
  // Interactive sessions start with a permission-mode entry — the watcher
  // uses this to distinguish them from --print title-generation sessions.
  const sessionId = 'abc123-test-session-id';
  const permLine = JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId }) + '\n';
  await writeFile(join(dir, `${sessionId}.jsonl`), permLine);

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

test('TranscriptWatcher: append twice — each new entry emits exactly once, no re-emission', async () => {
  const dir = join(tmpdir(), `tw-test-twice-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'mno345-append-twice';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const texts = [];
  watcher.on('event', e => { if (e.type === 'assistant') texts.push(e.message.content[0].text); });

  const line = (text, uuid) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    uuid, sessionId,
  }) + '\n';

  // First append → polled once.
  await appendFile(jsonlPath, line('first', 'u1'));
  await watcher.flush();
  assert.deepEqual(texts, ['first'], 'first append emits once');

  // Second append → only the new entry emits; the first is NOT re-read because
  // the byte offset advanced past it.
  await appendFile(jsonlPath, line('second', 'u2'));
  await watcher.flush();
  assert.deepEqual(texts, ['first', 'second'], 'second append emits only the new entry');

  // A poll with no new bytes must emit nothing.
  await watcher.flush();
  assert.deepEqual(texts, ['first', 'second'], 'idle poll re-emits nothing');

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

// --- Bug #8: defer synthetic completion for background Agent dispatches ---

test('a background-launch stub is not a completion and yields the agent id', () => {
  const stub = 'Async agent launched successfully.\nagentId: a2eb460474ced63b4 (internal ID - do not mention to user...)';
  const r = classifyToolResult(stub);
  assert.equal(r.background, true);
  assert.equal(r.agentId, 'a2eb460474ced63b4');
});

test('a regular tool_result is an immediate completion', () => {
  const r = classifyToolResult('DONE: branch=abc/TASK-001 commit=12ab34c files=[src/x.ts]');
  assert.equal(r.background, false);
});

test('a task-notification user entry resolves to the launched agent id', () => {
  const text = '<task-notification>\n<task-id>a2eb460474ced63b4</task-id>\n<status>completed</status>\n</task-notification>';
  assert.equal(parseTaskNotification(text), 'a2eb460474ced63b4');
});

test('parseTaskNotification matches the real queue-operation shape (with tool-use-id)', () => {
  // Real sample from a live transcript: the notification also carries a
  // <tool-use-id>, but we key on <task-id> (the internal agentId).
  const text = '<task-notification>\n<task-id>a3a7bc83b00cf3663</task-id>\n<tool-use-id>toolu_01Vrv5p7xCdw2Ao5ZuW7zhJC</tool-use-id>\n<status>killed</status>\n</task-notification>';
  assert.equal(parseTaskNotification(text), 'a3a7bc83b00cf3663');
});

test('TranscriptWatcher: a background Agent dispatch defers completion until the task-notification', async () => {
  const dir = join(tmpdir(), `tw-test-bg-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'bg-defer-session';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const events = [];
  watcher.on('event', e => events.push(e));

  const toolId = 'toolu_bg_001';
  const agentId = 'a3a7bc83b00cf3663';

  // 1. Assistant dispatches a background Agent → task_started, id tracked as pending.
  await appendFile(jsonlPath, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Agent', id: toolId, input: { description: 'Implement TASK-008', run_in_background: true } },
    ] },
    uuid: 'a1', sessionId,
  }) + '\n');
  await watcher.flush();

  // 2. Immediate stub tool_result → must NOT emit a completion.
  await appendFile(jsonlPath, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolId, content: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)` },
    ] },
    uuid: 'u1', sessionId,
  }) + '\n');
  await watcher.flush();

  assert.equal(
    events.filter(e => e.subtype === 'task_notification' && e.status === 'completed').length,
    0,
    'background stub must not synthesise a completion',
  );

  // 3. The real <task-notification> queue-operation entry → emits completion keyed on the Agent tool_use_id.
  await appendFile(jsonlPath, JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId,
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
  }) + '\n');
  await watcher.flush();

  const completions = events.filter(e => e.subtype === 'task_notification' && e.status === 'completed');
  assert.equal(completions.length, 1, 'task-notification should produce exactly one completion');
  assert.equal(completions[0].task_id, toolId, 'completion must be keyed on the Agent tool_use_id');

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: a foreground Agent tool_result still completes immediately', async () => {
  const dir = join(tmpdir(), `tw-test-fg-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'fg-immediate-session';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const events = [];
  watcher.on('event', e => events.push(e));

  const toolId = 'toolu_fg_001';
  await appendFile(jsonlPath, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Agent', id: toolId, input: { description: 'planner' } },
    ] },
    uuid: 'a1', sessionId,
  }) + '\n');
  await watcher.flush();

  await appendFile(jsonlPath, JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolId, content: 'DONE: tickets written' },
    ] },
    uuid: 'u1', sessionId,
  }) + '\n');
  await watcher.flush();

  const completions = events.filter(e => e.subtype === 'task_notification' && e.status === 'completed');
  assert.equal(completions.length, 1, 'foreground result must complete immediately');
  assert.equal(completions[0].task_id, toolId);

  watcher.close();
  await rm(dir, { recursive: true });
});

const assistantLine = (output) => JSON.stringify({
  type: 'assistant',
  message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: output } },
}) + '\n';

test('consumeTurnUsage counts only new subagent lines, across watcher instances', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'tw-usage-'));
  const csid = 'conv-test';
  const subDir = join(projectDir, csid, 'subagents');
  await mkdir(subDir, { recursive: true });
  await writeFile(join(subDir, 'agent-1.jsonl'), assistantLine(100));

  const shared = new Map();                       // = runtime.subagentUsageLines
  const w1 = new TranscriptWatcher(csid, projectDir, { subagentUsageLines: shared });
  const u1 = await w1.consumeTurnUsage();
  assert.equal(u1['claude-opus-4-8'].outputTokens, 100);

  await appendFile(join(subDir, 'agent-1.jsonl'), assistantLine(900));
  const u2 = await w1.consumeTurnUsage();
  assert.equal(u2['claude-opus-4-8'].outputTokens, 900);   // delta only

  const w2 = new TranscriptWatcher(csid, projectDir, { subagentUsageLines: shared });
  const u3 = await w2.consumeTurnUsage();
  assert.equal(u3['claude-opus-4-8'], undefined);          // nothing new
  w1.close(); w2.close();
  await rm(projectDir, { recursive: true });
});
