import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, extractToolUses, endsWithQuestion } from '../server.js';

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

test('endsWithQuestion detects direct questions', () => {
  assert.equal(endsWithQuestion('Which color do you prefer?'), true);
  assert.equal(endsWithQuestion("I've finished. Next?"), true);
});

test('endsWithQuestion ignores mid-message questions with a later conclusion', () => {
  assert.equal(endsWithQuestion('Should I proceed? Yes, I will.'), false);
  assert.equal(endsWithQuestion('Voici le plan:\n\n1. Étape 1\n2. Étape 2'), false);
  assert.equal(endsWithQuestion('Done!'), false);
  assert.equal(endsWithQuestion(''), false);
});

test('endsWithQuestion handles markdown trailing punctuation and emphasis', () => {
  assert.equal(endsWithQuestion('Done.\n\nAnything else to add?'), true);
  assert.equal(endsWithQuestion("J'ai terminé. **Questions?**"), true);
});

test('endsWithQuestion does NOT fire when a code block is the last paragraph', () => {
  assert.equal(
    endsWithQuestion('Dois-je procéder ?\n\n```js\nconst x = 1;\n```'),
    false,
  );
});
