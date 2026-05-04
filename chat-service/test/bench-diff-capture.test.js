import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDiff, parseNumstat } from '../tests/lib/diff-capture.js';

test('parseNumstat extracts files + line counts', () => {
  const raw = '5\t2\tsrc/foo.tsx\n12\t0\tsrc/bar.tsx\n';
  const stats = parseNumstat(raw);
  assert.deepEqual(stats, {
    filesChanged: 2,
    linesAdded: 17,
    linesRemoved: 2,
    perFile: [
      { added: 5, removed: 2, path: 'src/foo.tsx' },
      { added: 12, removed: 0, path: 'src/bar.tsx' },
    ],
  });
});

test('parseNumstat handles binary files (- - path)', () => {
  const raw = '-\t-\tsrc/logo.png\n3\t1\tsrc/foo.tsx\n';
  const stats = parseNumstat(raw);
  assert.equal(stats.filesChanged, 2);
  assert.equal(stats.linesAdded, 3);
  assert.equal(stats.linesRemoved, 1);
});

test('parseNumstat returns zeros for empty input', () => {
  assert.deepEqual(parseNumstat(''), {
    filesChanged: 0, linesAdded: 0, linesRemoved: 0, perFile: [],
  });
});

test('captureDiff calls runner for numstat, name-only, full patch', () => {
  const calls = [];
  const fakeRunner = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('--numstat')) return '5\t2\tsrc/foo.tsx\n';
    if (cmd.includes('--name-only')) return 'src/foo.tsx\n';
    return 'diff --git a/src/foo.tsx b/src/foo.tsx\n@@ ...\n';
  };
  const diff = captureDiff('atomic-crm-demo', { runner: fakeRunner });
  assert.equal(calls.length, 3);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0], 'src/foo.tsx');
  assert.equal(diff.numstat.filesChanged, 1);
  assert.match(diff.patch, /^diff --git/);
});
