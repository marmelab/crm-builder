import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderInlineMarkdown, escapeHtml } from '../public/lib/markdown.js';

test('escapeHtml escapes the five HTML-meaningful characters', () => {
  assert.equal(
    escapeHtml(`<a href="x" foo='y'>&copy;</a>`),
    '&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;copy;&lt;/a&gt;',
  );
});

test('renderInlineMarkdown renders **bold**', () => {
  assert.equal(
    renderInlineMarkdown('Industry: **SaaS / CRM**'),
    'Industry: <strong>SaaS / CRM</strong>',
  );
});

test('renderInlineMarkdown renders *italic*', () => {
  assert.equal(
    renderInlineMarkdown('plain *italic* plain'),
    'plain <em>italic</em> plain',
  );
});

test('renderInlineMarkdown renders `code`', () => {
  assert.equal(
    renderInlineMarkdown('use `git status` first'),
    'use <code>git status</code> first',
  );
});

test('renderInlineMarkdown handles multiple **bold** spans on one line', () => {
  assert.equal(
    renderInlineMarkdown('**a** middle **b**'),
    '<strong>a</strong> middle <strong>b</strong>',
  );
});

test('renderInlineMarkdown bold takes precedence over italic', () => {
  // ** must not be half-eaten as two separate * each.
  assert.equal(
    renderInlineMarkdown('**bold**'),
    '<strong>bold</strong>',
  );
});

test('renderInlineMarkdown escapes HTML before transforming', () => {
  // No injection: the script tag becomes inert text inside <strong>.
  const out = renderInlineMarkdown('**<script>alert(1)</script>**');
  assert.match(out, /^<strong>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/strong>$/);
});

test('renderInlineMarkdown leaves text without markdown untouched', () => {
  assert.equal(
    renderInlineMarkdown('plain text with no markup'),
    'plain text with no markup',
  );
});

test('renderInlineMarkdown preserves newlines (CSS handles wrapping)', () => {
  assert.equal(
    renderInlineMarkdown('line one\nline two'),
    'line one\nline two',
  );
});

test('renderInlineMarkdown does not match across line breaks', () => {
  // **foo\nbar** spans a line, ignore — keeps the regex predictable.
  assert.equal(
    renderInlineMarkdown('**foo\nbar**'),
    '**foo\nbar**',
  );
});
