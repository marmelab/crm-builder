const CRM_URL = process.env.CRM_URL || 'http://localhost:5173';

export default async function check(page) {
  await page.goto(CRM_URL);
  await page.getByText('My Friends').waitFor({ state: 'visible', timeout: 15000 });
  const oldLabel = await page.getByText('Hot Contacts').count();
  if (oldLabel > 0) throw new Error('old "Hot Contacts" label still visible');
}
