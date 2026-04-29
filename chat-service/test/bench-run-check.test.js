import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runPlaywrightCheck } from '../tests/lib/run-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'checks');

const fakePage = { goto: () => {}, getByText: () => ({ waitFor: async () => {} }) };
const fakeBrowser = {
  async launch() {
    return {
      async newContext() {
        return { async newPage() { return fakePage; } };
      },
      async close() {},
    };
  },
};

test('runPlaywrightCheck returns ran:false when no file exists', async () => {
  const r = await runPlaywrightCheck('does-not-exist', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, false);
});

test('runPlaywrightCheck returns success:true when check resolves', async () => {
  const r = await runPlaywrightCheck('passing', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, true);
  assert.equal(r.success, true);
});

test('runPlaywrightCheck returns success:false with error when check throws', async () => {
  const r = await runPlaywrightCheck('failing', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, true);
  assert.equal(r.success, false);
  assert.match(r.error, /expected failure for test/);
});

test('runPlaywrightCheck reports missing default export', async () => {
  const r = await runPlaywrightCheck('no-default', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, true);
  assert.equal(r.success, false);
  assert.match(r.error, /missing default export/);
});

test('runPlaywrightCheck times out a hanging check', async () => {
  const r = await runPlaywrightCheck('hangs', { checksDir: FIXTURES, browser: fakeBrowser, timeoutMs: 50 });
  assert.equal(r.ran, true);
  assert.equal(r.success, false);
  assert.match(r.error, /timed out after 50ms/);
});
