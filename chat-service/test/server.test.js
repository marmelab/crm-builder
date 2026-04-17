import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, extractToolUses } from '../server.js';

test('extractText returns text from assistant message', () => {
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 'x', name: 'Read', input: {} },
        { type: 'text', text: ' from Claude' },
      ],
    },
  };
  assert.equal(extractText(msg), 'Hello world from Claude');
});

test('extractText returns null for non-assistant messages', () => {
  assert.equal(extractText({ type: 'system' }), null);
  assert.equal(extractText({ type: 'result' }), null);
});

test('extractToolUses returns all tool_use blocks', () => {
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', name: 'Task', input: { description: 'planner' } },
        { type: 'tool_use', name: 'TeamCreate', input: { agents: [] } },
      ],
    },
  };
  const tools = extractToolUses(msg);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'Task');
  assert.equal(tools[1].name, 'TeamCreate');
});

test('extractToolUses returns empty for non-assistant messages', () => {
  assert.deepEqual(extractToolUses({ type: 'result' }), []);
});

test('extractText returns null when text is only whitespace', () => {
  const msg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: '   \n  ' }] },
  };
  assert.equal(extractText(msg), null);
});
