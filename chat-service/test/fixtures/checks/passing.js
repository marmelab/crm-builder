export default async function check(page) {
  if (typeof page.goto !== 'function') throw new Error('no page.goto');
}
