// WCAG 2.2 A/AA (axe-core) on every screen, in both themes, at 390 px and desktop. Each theme is
// chosen in the app against the opposite device setting, so the choice is what's tested.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, contextOptions, seedTrip, signedIn } from './support';

const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } } as const;

async function expectAccessible(page: Page, screen: string) {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact ?? '?'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, `${screen}: ${summary.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`WCAG AA: every screen, ${size}, ${scheme}`, async ({ browser }) => {
      test.setTimeout(240_000); // ~12 screens, each a full axe scan
      const opts = { viewport, colorScheme: scheme === 'light' ? 'dark' as const : 'light' as const };
      const theme = async (c: BrowserContext) => { await c.addInitScript((t) => { localStorage.setItem('hisaab-theme', t); }, scheme); };
      const asha = await signedIn(browser, 'Asha', opts);
      const bilal = await signedIn(browser, 'Bilal', opts);
      await theme(asha.context);
      const { groupId, members } = await seedTrip(asha.context.request, bilal.context.request);
      const page = asha.page;
      const a = apiFor(asha.context.request);

      const anon = await browser.newContext(contextOptions(opts));
      await theme(anon);
      const signIn = await anon.newPage();
      await signIn.goto('/signin');
      await expectAccessible(signIn, 'sign in');
      await signIn.getByRole('button', { name: 'Sign in' }).click(); // with its error showing
      await expectAccessible(signIn, 'sign in, error');
      for (const path of ['/privacy', '/terms', '/no/such/page']) {
        await signIn.goto(path);
        await expectAccessible(signIn, path);
      }
      await anon.close();

      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme); // the choice, not the device
      await expectAccessible(page, 'home');

      await page.route('**/AccountPage*', (r) => r.abort()); // a chunk that won't load
      await page.goto('/account');
      await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
      await expectAccessible(page, 'error page');
      await page.unroute('**/AccountPage*');

      for (const tab of size === 'phone' ? ['activity', 'balances', 'settle', 'members'] : ['activity']) {
        await page.goto(`/groups/${groupId}?tab=${tab}`);
        await expectAccessible(page, `group ${tab}`);
      }
      await page.getByRole('button', { name: 'Invite Dev' }).click();
      await expectAccessible(page, 'group with an invite link');

      await page.goto(`/groups/${groupId}/expenses/new`);
      await expectAccessible(page, 'add expense');
      await page.getByText('Percentages').click();
      await page.getByLabel('Amount', { exact: true }).fill('12.345');
      await page.getByRole('button', { name: 'Add expense' }).click(); // validation errors showing
      await expectAccessible(page, 'add expense, errors');

      const { expenseId } = await a.expense(groupId, 'Breakfast', 60000, members.asha, [members.asha, members.bilal]);
      await page.goto(`/groups/${groupId}/expenses/${expenseId}`);
      await expectAccessible(page, 'expense');
      await page.goto(`/groups/${groupId}/expenses/${expenseId}/edit`);
      await page.getByLabel('Amount', { exact: true }).fill('700');
      const bilalEdit = await bilal.context.request.put(`/api/groups/${groupId}/expenses/${expenseId}`, {
        headers: { Origin: 'http://localhost:5174', 'If-Match': '1' },
        data: {
          description: 'Breakfast', occurredOn: '2026-10-18', totalMinor: 80000,
          payers: [{ memberId: members.asha, paidMinor: 80000 }],
          split: { method: 'equal', weights: [{ memberId: members.asha, weight: 1 }, { memberId: members.bilal, weight: 1 }] },
        },
      });
      expect(bilalEdit.ok()).toBeTruthy();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(page.getByText('Someone changed this expense while you were editing')).toBeVisible();
      await expectAccessible(page, 'edit conflict');

      await page.goto(`/groups/${groupId}/settle`);
      await expectAccessible(page, 'settle up');

      const { token } = await a.invite(groupId, members.chirag);
      const chirag = await signedIn(browser, 'Chirag', opts);
      await theme(chirag.context);
      await chirag.page.goto(`/join/${token}`);
      await expectAccessible(chirag.page, 'join');

      await chirag.context.close();
      await asha.context.close();
      await bilal.context.close();
    });
  }
}
