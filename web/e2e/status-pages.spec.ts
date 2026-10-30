// What a visitor sees when no page can: never the router's developer error.
import { expect, test } from '@playwright/test';
import { signedIn } from './support';

const DEV_HINTS = /Unexpected Application Error|Hey developer|errorElement|ErrorBoundary/;

test('an unknown address shows the 404 page, signed out and at any depth', async ({ page }) => {
  for (const path of ['/no-such-page', '/groups/x/y/z/nope']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(DEV_HINTS);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  }
  await page.getByRole('link', { name: 'Back to Hisaab' }).click();
  await expect(page).toHaveURL(/\/signin/);
});

test('a screen that fails to load shows the friendly page, and reload recovers', async ({ browser }) => {
  const { page, context } = await signedIn(browser, 'Asha');
  await page.route('**/AccountPage*', (r) => r.abort());
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(DEV_HINTS);
  await page.unroute('**/AccountPage*');
  await page.getByRole('button', { name: 'Reload the page' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await context.close();
});
