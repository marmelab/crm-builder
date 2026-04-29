const CRM_URL = process.env.CRM_URL || 'http://localhost:5173';

export default async function check(page) {
  await page.goto(`${CRM_URL}/deals/1/edit`);
  await page.waitForLoadState('networkidle');

  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });

  const priorityLabel = await dialog.getByText(/priority/i).count();
  if (priorityLabel === 0) {
    throw new Error('no "priority" field/label in deal edit form');
  }

  const editHtml = (await dialog.innerHTML()).toLowerCase();
  for (const value of ['low', 'medium', 'high']) {
    if (!editHtml.includes(value)) {
      throw new Error(`priority value "${value}" missing from edit form`);
    }
  }

  await page.goto(`${CRM_URL}/deals`);
  await page.waitForLoadState('networkidle');
  const boardHtml = (await page.locator('body').innerHTML()).toLowerCase();
  const cardMentionsPriority =
    boardHtml.includes('priority') ||
    /\b(low|medium|high)\b/.test(boardHtml.replace(/\s+/g, ' '));
  if (!cardMentionsPriority) {
    throw new Error('no priority indicator on deal cards (kanban board)');
  }
}
