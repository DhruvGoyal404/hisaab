import { expect, test } from '@playwright/test';
import { apiFor, contextOptions, signedIn } from './support';

test('claiming a placeholder through an invite link opened in a second browser', async ({ browser }) => {
  const asha = await signedIn(browser, 'Asha');
  const a = apiFor(asha.context.request);
  const { groupId, memberId: ashaId } = await a.createGroup('Claim check');
  const { memberId: chiragId } = await a.addGhost(groupId, 'Chirag');
  await a.expense(groupId, 'Train tickets', 60000, ashaId, [ashaId, chiragId]);

  // Asha makes the link from the Members section.
  await asha.page.goto(`/groups/${groupId}`);
  await asha.page.getByRole('button', { name: 'Invite Chirag' }).click();
  const link = await asha.page.getByLabel('Link for Chirag').inputValue();
  expect(link).toMatch(/\/join\/[\w-]{43}$/);

  // Chirag, on their own phone and not signed in, opens it.
  const phone = await browser.newContext(contextOptions({ viewport: { width: 390, height: 844 } }));
  const page = await phone.newPage();
  await page.goto(link);
  await expect(page).toHaveURL(/\/signin\?next=/);
  await page.getByLabel('Your name').fill('Chirag Mehta');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Asha invited you to Claim check as Chirag.')).toBeVisible();
  await expect(page.getByText('Expenses already recorded for Chirag become yours.')).toBeVisible();
  await page.getByRole('button', { name: 'Join as Chirag' }).click();

  await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`));
  await expect(page.getByRole('banner')).toContainText('You owe ₹300.00');
  await page.goto(`/groups/${groupId}?tab=balances`);
  await expect(page.getByRole('listitem').filter({ hasText: 'You' })).toContainText('owes ₹300.00');

  // The link is single-use.
  await page.goto(link);
  await expect(page.getByText('This link has already been used or has expired.')).toBeVisible();
  await phone.close();
  await asha.context.close();
});
