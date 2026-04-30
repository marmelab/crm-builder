import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestLog } from '../lib/server/session-store.js';

// Helpers — keep fixtures inline so each test is self-describing.
const userMessage = (content, ts = '2026-04-30T12:00:00.000Z') =>
  JSON.stringify({ ts, dir: 'in', type: 'user_message', content });

const assistantMessage = (content, ts = '2026-04-30T12:00:01.000Z') =>
  JSON.stringify({ ts, dir: 'out', type: 'message', role: 'assistant', content });

const resultEvent = (usage, totalCost, ts = '2026-04-30T12:00:02.000Z') => JSON.stringify({
  ts, dir: 'out', type: 'debug_raw',
  event: { type: 'result', usage, total_cost_usd: totalCost },
});

test('digestLog: tokensUsed sums input + cache_creation + output, EXCLUDES cache_read', () => {
  const log = [
    resultEvent({
      input_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 5000, // must be ignored
      output_tokens: 50,
    }, 0.01),
  ].join('\n');

  const { stats } = digestLog(log);
  assert.equal(stats.tokensUsed, 350);
  assert.equal(stats.costUsd, 0.01);
});

test('digestLog: sums tokens and cost across multiple result events (one per spawn)', () => {
  const log = [
    resultEvent({ input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 5 }, 0.001),
    resultEvent({ input_tokens: 30, cache_creation_input_tokens: 40, output_tokens: 15 }, 0.004),
    resultEvent({ input_tokens: 0,  cache_creation_input_tokens: 0,  output_tokens: 100 }, 0.002),
  ].join('\n');

  const { stats } = digestLog(log);
  assert.equal(stats.tokensUsed, 10 + 20 + 5 + 30 + 40 + 15 + 100);
  assert.ok(Math.abs(stats.costUsd - 0.007) < 1e-9);
});

test('digestLog: skips malformed JSON lines without crashing', () => {
  const log = [
    userMessage('Hello'),
    'not-valid-json',
    '{ "broken": ',
    '',
    assistantMessage('Hi there'),
  ].join('\n');

  const { messages, stats } = digestLog(log);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'Hello');
  assert.equal(messages[1].content, 'Hi there');
  assert.equal(stats.tokensUsed, 0);
  assert.equal(stats.costUsd, 0);
});

test('digestLog: extracts user/assistant messages and returns zeroed stats when no result events', () => {
  const log = [
    userMessage('First question'),
    assistantMessage('First answer'),
    userMessage('Second question', '2026-04-30T12:01:00.000Z'),
  ].join('\n');

  const { messages, stats } = digestLog(log);
  assert.deepEqual(
    messages.map((m) => ({ role: m.role, content: m.content })),
    [
      { role: 'user',      content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user',      content: 'Second question' },
    ],
  );
  assert.equal(stats.tokensUsed, 0);
  assert.equal(stats.costUsd, 0);
});

test('digestLog: prefers user_message.display over .content (choice button label)', () => {
  // Choice clicks send `content: 'FULL_SETUP'` for the orchestrator and
  // `display: '🗺️ Set up...'` for the chat bubble — the digest must surface
  // the human-readable label, not the routing token.
  const log = JSON.stringify({
    ts: '2026-04-30T12:00:00.000Z', dir: 'in', type: 'user_message',
    content: 'FULL_SETUP', display: '🗺️  Set up my CRM from scratch',
  });

  const { messages } = digestLog(log);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '🗺️  Set up my CRM from scratch');
});
