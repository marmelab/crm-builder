import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrompt } from '../lib/server/pty-session.js';

// Claude Code interactive prompt appears on its own after a response.
// After strip-ansi the prompt line contains ❯ or > at the end of the text.
// The welcome-screen "❯ <suggestion>" does NOT trigger (❯ is mid-text there).

test('detectPrompt: returns true for ❯ at end of text', () => {
  assert.equal(detectPrompt('some text\n❯ '), true);
});

test('detectPrompt: returns true for > at end of line', () => {
  assert.equal(detectPrompt('response text\n> '), true);
});

test('detectPrompt: returns false for mid-text > (not a prompt)', () => {
  assert.equal(detectPrompt('Here is a comparison: a > b and c < d'), false);
});

test('detectPrompt: returns false for empty string', () => {
  assert.equal(detectPrompt(''), false);
});

test('detectPrompt: returns true for ❯ with trailing spaces', () => {
  assert.equal(detectPrompt('done\n❯   '), true);
});

test('detectPrompt: returns false for > inside a code block line', () => {
  // > appears mid-line in markdown blockquotes — should not trigger
  assert.equal(detectPrompt('> This is a blockquote line with more text after'), false);
});

test('detectPrompt: returns false for welcome-screen ❯ (mid-text with suggestion)', () => {
  // The welcome-screen chunk: "❯ Try 'create a util...'" followed by more lines
  assert.equal(detectPrompt('ClaudeCode\r\r\n❯ Try "create a util logging.py"\r\r\nbypass permissions\r\r\n'), false);
});
