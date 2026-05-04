import { ensureLoggedIn } from './_helpers/login.js';

const CRM_URL = process.env.CRM_URL || 'http://localhost:5173';

export default async function check(page) {
  await ensureLoggedIn(page, CRM_URL);

  await page.goto(`${CRM_URL}/#/deals/1/show`);
  await page.waitForLoadState('networkidle');
  await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[role="dialog"]').first().getByText(/^edit$/i).first().click();

  const editDialog = page.locator('[role="dialog"]').last();
  await editDialog.waitFor({ state: 'visible', timeout: 15000 });
  await editDialog.locator('input, select').first().waitFor({ state: 'visible', timeout: 5000 });

  if ((await editDialog.getByText(/priority/i).count()) === 0) {
    throw new Error('no "priority" field/label in deal edit form');
  }
  const editHtml = (await editDialog.innerHTML()).toLowerCase();
  for (const value of ['low', 'medium', 'high']) {
    if (!editHtml.includes(value)) {
      throw new Error(`priority value "${value}" missing from edit form`);
    }
  }

  await page.goto(`${CRM_URL}/#/deals`);
  await page.waitForLoadState('networkidle');
  const boardHtml = (await page.locator('body').innerHTML()).toLowerCase();
  const cardMentionsPriority =
    boardHtml.includes('priority') ||
    /\b(low|medium|high)\b/.test(boardHtml.replace(/\s+/g, ' '));
  if (!cardMentionsPriority) {
    throw new Error('no priority indicator on deal cards (kanban board)');
  }
}
