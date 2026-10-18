// Captures every main screen at phone (390 px) and desktop widths, light and dark, for docs/img.
// Run on demand: npx playwright test screenshots  (SCREENSHOT_DIR overrides the output folder).
import { fileURLToPath } from 'node:url';
import { test, type Page } from '@playwright/test';
import { seedTrip, signedIn } from './support';

const OUT = process.env.SCREENSHOT_DIR ?? fileURLToPath(new URL('../../docs/img', import.meta.url));
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } } as const;

test.describe.configure({ mode: 'serial' });

for (const scheme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`screens: ${size}, ${scheme}`, async ({ browser }) => {
      const opts = { viewport, colorScheme: scheme, deviceScaleFactor: size === 'phone' ? 2 : 1 };
      const asha = await signedIn(browser, 'Asha', opts);
      const bilal = await signedIn(browser, 'Bilal', opts);
      const { groupId } = await seedTrip(asha.context.request, bilal.context.request);
      const page = asha.page;
      const shot = async (name: string, p: Page = page) => {
        await p.waitForLoadState('networkidle');
        await p.screenshot({ path: `${OUT}/${name}-${size}-${scheme}.png`, fullPage: true });
      };

      await page.goto('/');
      await shot('home');
      await page.goto(`/groups/${groupId}`);
      await shot('group');
      if (size === 'phone') {
        await page.goto(`/groups/${groupId}?tab=balances`);
        await shot('balances');
        await page.goto(`/groups/${groupId}?tab=settle`);
        await shot('settle-plan');
        await page.goto(`/groups/${groupId}?tab=members`);
        await shot('members');
      }
      await page.goto(`/groups/${groupId}/expenses/new`);
      await page.getByLabel('What was it for?').fill('Parasailing');
      await page.getByLabel('Amount', { exact: true }).fill('4,800');
      await page.getByText('Exact amounts').click();
      await page.getByLabel('Asha owes').fill('1,500');
      await page.getByLabel('Bilal owes').fill('1,500');
      await page.getByLabel('Chirag owes').fill('1,500');
      await shot('add-expense');
      await page.goto(`/groups/${groupId}/settle`);
      await shot('settle-up');

      const anon = await browser.newContext(opts);
      const signIn = await anon.newPage();
      await signIn.goto('/signin');
      await shot('signin', signIn);
      await anon.close();
      await asha.context.close();
      await bilal.context.close();
    });
  }
}
