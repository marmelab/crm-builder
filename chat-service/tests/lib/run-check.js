import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runPlaywrightCheck(caseId, { checksDir, browser } = {}) {
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
    await check(page);
    return { ran: true, success: true };
  } catch (err) {
    return { ran: true, success: false, error: err.message };
  } finally {
    await launched.close();
  }
}
