// Captures the main screens for docs/img: every screen at 390 px and desktop in light, plus home and
// group in dark. Run on purpose: npm run screenshots -w web (a throwaway database, so accounts look new;
// SCREENSHOT_DIR overrides the output folder).
import { fileURLToPath } from 'node:url';
import { test, type APIRequestContext, type Page } from '@playwright/test';
import { apiFor, contextOptions, ORIGIN, seedTrip, signedIn } from './support';

const OUT = process.env.SCREENSHOT_DIR ?? fileURLToPath(new URL('../../docs/img', import.meta.url));
const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } } as const;

test.describe.configure({ mode: 'serial' });

// One group shared by all four runs, so every screenshot shows the same believable account.
let seeded: Promise<{ groupId: string; members: Awaited<ReturnType<typeof seedTrip>>['members']; expenseId: string }> | undefined;
function seedOnce(asha: APIRequestContext, bilal: APIRequestContext) {
  seeded ??= (async () => {
    const { groupId, members } = await seedTrip(asha, bilal);
    const { expenseId } = await apiFor(asha).post<{ expenseId: string }>(`/api/groups/${groupId}/expenses`, {
      description: 'Dinner at Gunpowder', occurredOn: '2026-10-18', totalMinor: 286050,
      payers: [{ memberId: members.asha, paidMinor: 200000 }, { memberId: members.bilal, paidMinor: 86050 }],
      split: {
        method: 'shares',
        weights: [{ memberId: members.asha, weight: 2 }, { memberId: members.bilal, weight: 1 }, { memberId: members.chirag, weight: 1 }],
      },
    }, { 'Idempotency-Key': crypto.randomUUID() });
    return { groupId, members, expenseId };
  })();
  return seeded;
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`screens: ${size}, ${scheme}`, async ({ browser }) => {
      test.setTimeout(240_000);
      const phone = size === 'phone';
      const opts = { viewport, colorScheme: scheme, deviceScaleFactor: phone ? 2 : 1 };
      const asha = await signedIn(browser, 'Asha', opts);
      const bilal = await signedIn(browser, 'Bilal', opts);
      const { groupId, members, expenseId } = await seedOnce(asha.context.request, bilal.context.request);
      const page = asha.page;
      const a = apiFor(asha.context.request);
      const shot = async (name: string, p: Page = page) => {
        await p.waitForLoadState('networkidle');
        await p.evaluate(() => { window.scrollTo(0, 0); });
        await p.screenshot({ path: `${OUT}/${name}-${size}-${scheme}.png`, fullPage: true });
      };

      await page.goto('/');
      await shot('home');
      await page.goto(`/groups/${groupId}`);
      await shot('group');

      if (scheme === 'light') {
        if (phone) {
          for (const tab of ['balances', 'settle', 'members'] as const) {
            await page.goto(`/groups/${groupId}?tab=${tab}`);
            await shot(tab === 'settle' ? 'settle-plan' : tab);
          }
        }

        await page.goto(`/groups/${groupId}/expenses/new`);
        await page.getByLabel('What was it for?').fill('Parasailing at Calangute');
        await page.getByLabel('Amount', { exact: true }).fill('4,800');
        await page.getByText('Exact amounts').click();
        await page.getByLabel('Asha owes').fill('1,500');
        await page.getByLabel('Bilal owes').fill('1,500');
        await page.getByLabel('Chirag owes').fill('1,500');
        await shot('add-expense');

        await page.goto(`/groups/${groupId}/expenses/${expenseId}`);
        await shot('expense');

        await page.goto(`/groups/${groupId}/settle`);
        await shot('settle-up');

        const { token } = await a.invite(groupId, members.dev);
        const dev = await browser.newContext(contextOptions(opts));
        await dev.request.post('/api/dev/login', { data: { name: 'Dev' }, headers: { Origin: ORIGIN } });
        const devPage = await dev.newPage();
        await devPage.goto(`/join/${token}`);
        await shot('join', devPage);
        await dev.close();

        const anon = await browser.newContext(contextOptions(opts));
        const signIn = await anon.newPage();
        await signIn.goto('/signin');
        await shot('signin', signIn);
        await anon.close();
      }
      await asha.context.close();
      await bilal.context.close();
    });
  }
}
