import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../server.js';

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

test('extractText returns null when text is only whitespace', () => {
  const msg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: '   \n  ' }] },
  };
  assert.equal(extractText(msg), null);
});
