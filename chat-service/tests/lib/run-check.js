import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runPlaywrightCheck(caseId, { checksDir, browser, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!checksDir) throw new Error('checksDir is required');
  if (!browser) {
    const pw = await import('playwright');
    browser = pw.chromium;
  }
  const checkPath = join(checksDir, `${caseId}.js`);
  if (!existsSync(checkPath)) return { ran: false };

  const mod = await import(pathToFileURL(checkPath).href);
  const check = mod.default;
  if (typeof check !== 'function') {
    return { ran: true, success: false, error: `${caseId}.js: missing default export function` };
  }

  const launched = await browser.launch();
  try {
    const ctx = await launched.newContext();
    const page = await ctx.newPage();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`check timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([check(page), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { ran: true, success: true };
  } catch (err) {
    return { ran: true, success: false, error: err.message };
  } finally {
    await launched.close();
  }
}
