const EMAIL = process.env.BENCH_LOGIN_EMAIL || 'janedoe@atomic.dev';
const PASSWORD = process.env.BENCH_LOGIN_PASSWORD || 'demo';

export async function ensureLoggedIn(page, baseUrl) {
  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState('networkidle');

  const emailField = page
    .locator('input[type="email"], input[name="email"], input[name="username"]')
    .first();
  if ((await emailField.count()) === 0) return;

  await emailField.fill(EMAIL);
  await page
    .locator('input[type="password"], input[name="password"]')
    .first()
    .fill(PASSWORD);
  await page
    .locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")')
    .first()
    .click();
  await page.waitForLoadState('networkidle');
}
