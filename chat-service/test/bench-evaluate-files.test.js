import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFileSet, matchesGlob } from '../tests/lib/evaluate-files.js';

test('matchesGlob supports literal, **, and *.ext', () => {
  assert.equal(matchesGlob('src/foo.tsx', 'src/foo.tsx'), true);
  assert.equal(matchesGlob('src/foo.tsx', 'src/bar.tsx'), false);
  assert.equal(matchesGlob('src/atomic-crm/contacts/Foo.tsx', 'src/atomic-crm/contacts/**'), true);
  assert.equal(matchesGlob('src/atomic-crm/deals/Foo.tsx', 'src/atomic-crm/contacts/**'), false);
  assert.equal(matchesGlob('src/foo.tsx', '**/*.tsx'), true);
  assert.equal(matchesGlob('src/foo.css', '**/*.tsx'), false);
});

test('mustModify warns on missing expected file', () => {
  const diff = { files: ['src/foo.tsx'], numstat: { filesChanged: 1, linesAdded: 5, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, { mustModify: ['src/foo.tsx', 'src/bar.tsx'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /src\/bar\.tsx/);
});

test('mustModify silent when all expected files touched', () => {
  const diff = { files: ['src/foo.tsx', 'src/bar.tsx'], numstat: { filesChanged: 2, linesAdded: 5, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, { mustModify: ['src/foo.tsx'] });
  assert.deepEqual(warnings, []);
});

test('mustNotModify warns per matched file', () => {
  const diff = { files: ['src/atomic-crm/contacts/Foo.tsx', 'src/foo.tsx'], numstat: { filesChanged: 2, linesAdded: 0, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, { mustNotModify: ['src/atomic-crm/contacts/**'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /contacts\/Foo\.tsx/);
});

test('expectedDiffStats accepts within ±100% (half to double)', () => {
  const within = { files: [], numstat: { filesChanged: 1, linesAdded: 10, linesRemoved: 2 } };
  const { warnings } = evaluateFileSet(within, {
    expectedDiffStats: { filesChanged: 1, linesAdded: 8, linesRemoved: 2 },
  });
  assert.deepEqual(warnings, []);
});

test('expectedDiffStats warns when linesAdded > 2× expected', () => {
  const explosion = { files: [], numstat: { filesChanged: 1, linesAdded: 50, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(explosion, {
    expectedDiffStats: { filesChanged: 1, linesAdded: 8, linesRemoved: 0 },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /linesAdded/);
});

test('absent expect keys produce no warnings', () => {
  const diff = { files: ['src/foo.tsx'], numstat: { filesChanged: 1, linesAdded: 5, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, {});
  assert.deepEqual(warnings, []);
});
