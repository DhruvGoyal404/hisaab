// Phase 5's definition of done, end to end through the UI in two browsers: create a group, invite,
// add expenses with every split type and one with several payers, then settle with the suggested
// plan until both browsers show the बराबर (all square) stamp.
import { expect, test, type Page } from '@playwright/test';
import { contextOptions } from './support';

type Expense = {
  description: string;
  amount: string;
  method: 'Equally' | 'Exact amounts' | 'Percentages' | 'Shares';
  payer?: string;
  payers?: Record<string, string>;
  values?: Record<string, string>;
};

const FIELD = { 'Exact amounts': (n: string) => `${n} owes`, Percentages: (n: string) => `${n}’s percentage`, Shares: (n: string) => `${n}’s shares` } as const;

async function signIn(page: Page, name: string) {
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function addExpense(page: Page, groupId: string, e: Expense) {
  await page.goto(`/groups/${groupId}/expenses/new`);
  await page.getByLabel('What was it for?').fill(e.description);
  await page.getByLabel('Amount', { exact: true }).fill(e.amount);
  if (e.payers) {
    await page.getByText('Several people').click();
    for (const [name, paid] of Object.entries(e.payers)) await page.getByLabel(`${name} paid`).fill(paid);
  } else if (e.payer) {
    await page.getByLabel('Who paid').selectOption({ label: e.payer });
  }
  await page.getByText(e.method, { exact: true }).click();
  if (e.method !== 'Equally') {
    for (const [name, value] of Object.entries(e.values ?? {})) await page.getByLabel(FIELD[e.method](name)).fill(value);
  }
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`));
}

const stamp = (page: Page) => page.getByRole('img', { name: 'बराबर, all square' });

test('create → invite → every split type → settle until both browsers show बराबर', async ({ browser }) => {
  test.setTimeout(240_000);
  // Asha on a phone, Bilal on a laptop.
  const ashaCtx = await browser.newContext(contextOptions({ viewport: { width: 390, height: 844 } }));
  const bilalCtx = await browser.newContext(contextOptions({ viewport: { width: 1280, height: 860 } }));
  const asha = await ashaCtx.newPage();
  const bilal = await bilalCtx.newPage();

  // Asha signs in and starts a group.
  await asha.goto('/');
  await signIn(asha, 'Asha');
  await asha.getByLabel('Group name').fill('Holi weekend');
  await asha.getByRole('button', { name: 'Create group' }).click();
  await expect(asha).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
  const groupId = /groups\/([0-9a-f-]{36})/.exec(asha.url())?.[1] ?? '';

  // Asha invites Bilal; Bilal opens the link signed out, signs in and joins.
  await asha.goto(`/groups/${groupId}?tab=members`);
  await asha.getByRole('button', { name: 'Create invite link' }).click();
  const link = await asha.getByLabel('Invite link for anyone').inputValue();
  await bilal.goto(link);
  await signIn(bilal, 'Bilal');
  await bilal.getByRole('button', { name: 'Join Holi weekend' }).click();
  await expect(bilal).toHaveURL(new RegExp(`/groups/${groupId}$`));

  // Every split type, plus one with two payers. Running balance (Asha's side) in comments.
  await addExpense(asha, groupId, { description: 'Thandai and gujiya', amount: '1,200', method: 'Equally' }); // +600
  await addExpense(bilal, groupId, {
    description: 'Colours and water guns', amount: '1,000', method: 'Exact amounts', payer: 'Bilal (you)',
    values: { Asha: '600', Bilal: '400' },
  }); // 0
  await addExpense(asha, groupId, {
    description: 'Lunch at Bademiya', amount: '900', method: 'Percentages', values: { Asha: '30', Bilal: '70' },
  }); // +630
  await addExpense(bilal, groupId, {
    description: 'Cab both ways', amount: '1,500', method: 'Shares', payer: 'Bilal (you)', values: { Asha: '2', Bilal: '1' },
  }); // -370
  await addExpense(asha, groupId, {
    description: 'Dinner at the dhaba', amount: '2,000', method: 'Equally', payers: { Asha: '1,500', Bilal: '500' },
  }); // +130

  // The plan on Asha's phone: Bilal pays her ₹130.00. Bilal's laptop agrees, without a reload.
  await asha.goto(`/groups/${groupId}?tab=settle`);
  await expect(asha.getByRole('listitem').filter({ hasText: 'Bilal pays you' })).toContainText('₹130.00');
  await expect(bilal.getByRole('listitem').filter({ hasText: 'You pay Asha' })).toContainText('₹130.00');

  // Settle with the suggested plan until nothing is left.
  for (let round = 0; round < 5; round++) {
    await asha.goto(`/groups/${groupId}?tab=settle`);
    const record = asha.getByRole('link', { name: /^Record/ });
    await expect(record.first().or(asha.getByText('No payments needed.'))).toBeVisible();
    if ((await record.count()) === 0) break;
    await record.first().click();
    await asha.getByRole('button', { name: 'Record payment' }).click();
    await expect(asha).toHaveURL(new RegExp(`/groups/${groupId}\\?tab=balances$`));
  }

  // बराबर in both browsers: Asha after her own write, Bilal live.
  await expect(stamp(asha)).toBeVisible();
  await expect(asha.getByRole('banner')).toContainText('You are all square');
  await expect(stamp(bilal).first()).toBeVisible({ timeout: 10_000 });
  await expect(bilal.getByRole('banner')).toContainText('You are all square');

  await ashaCtx.close();
  await bilalCtx.close();
});
