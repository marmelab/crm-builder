const CRM_URL = process.env.CRM_URL || 'http://localhost:5173';

export default async function check(page) {
  await page.goto(CRM_URL);
  await page.waitForLoadState('networkidle');
  const refresh = await page
    .locator('button:has(svg.lucide-rotate-cw), button:has(svg.lucide-loader-circle), button[aria-label*="refresh" i], button:has-text("Refresh")')
    .count();
  if (refresh > 0) throw new Error(`refresh button still present (count=${refresh})`);
}
