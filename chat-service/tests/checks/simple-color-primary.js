const CRM_URL = process.env.CRM_URL || 'http://localhost:5173';

export default async function check(page) {
  await page.goto(CRM_URL);
  await page.waitForLoadState('networkidle');
  const isPurple = await page.evaluate(() => {
    const el = document.querySelector('button, [class*="primary"], [class*="MuiButton-contained"]');
    if (!el) return false;
    const c = getComputedStyle(el).backgroundColor;
    const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return b > r * 0.8 && r > g + 30;
  });
  if (!isPurple) throw new Error('primary color does not look purple');
}
