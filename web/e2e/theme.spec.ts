// The theme: chosen per browser, applied before the first paint, and within the CSP.
import { expect, test, type Page } from '@playwright/test';
import { signedIn } from './support';

const DARK_PAGE = 'rgb(22, 20, 42)'; // index.css --page, dark
const LIGHT_PAGE = 'rgb(252, 252, 254)';
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

test('a chosen theme is there before the app runs: no flash of the other one', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  await context.addInitScript(() => { localStorage.setItem('hisaab-theme', 'dark'); });
  const page = await context.newPage();
  // Without the app's own JavaScript, only theme.js can have set it.
  await page.route('**/*.{tsx,ts}', (r) => r.abort());
  await page.route('**/assets/*.js', (r) => r.abort());
  await page.goto('/signin');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(DARK_PAGE);
  await context.close();
});

test('the choice follows the device by default, is kept per browser, and breaks no CSP rule', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  const cspErrors: string[] = [];
  page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text())) cspErrors.push(m.text()); });

  await page.goto('/signin');
  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(theme.getByRole('radio', { name: 'System' })).toBeChecked();
  expect(await background(page)).toBe(DARK_PAGE);

  await theme.getByRole('radio', { name: 'Light' }).check();
  expect(await background(page)).toBe(LIGHT_PAGE);
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' })).toBeChecked();
  expect(await background(page)).toBe(LIGHT_PAGE);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System' }).check();
  expect(await background(page)).toBe(LIGHT_PAGE);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => background(page)).toBe(DARK_PAGE);

  expect(cspErrors).toEqual([]);
  await context.close();
});

test('the account page offers the same choice', async ({ browser }) => {
  const { page, context } = await signedIn(browser, 'Asha', { colorScheme: 'light' });
  await page.goto('/account');
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).check();
  expect(await background(page)).toBe(DARK_PAGE);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await context.close();
});
