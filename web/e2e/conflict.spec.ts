import { expect, test, type Browser } from '@playwright/test';
import { apiFor, signedIn } from './support';

/** Asha and Bilal in one group with one ₹1,000.00 dinner, both on its edit page. */
async function bothEditing(browser: Browser) {
  const asha = await signedIn(browser, 'Asha', { viewport: { width: 390, height: 844 } });
  const bilal = await signedIn(browser, 'Bilal');
  const a = apiFor(asha.context.request);
  const { groupId, memberId: ashaId } = await a.createGroup('Conflict check');
  const { token } = await a.invite(groupId);
  const { memberId: bilalId } = await apiFor(bilal.context.request).accept(token);
  const { expenseId } = await a.expense(groupId, 'Dinner', 100000, ashaId, [ashaId, bilalId]);
  const edit = `/groups/${groupId}/expenses/${expenseId}/edit`;
  await asha.page.goto(edit);
  await bilal.page.goto(edit);
  await expect(asha.page.getByLabel('Amount', { exact: true })).toHaveValue('1,000.00');
  await expect(bilal.page.getByLabel('Amount', { exact: true })).toHaveValue('1,000.00');
  return { asha, bilal, groupId, expenseId };
}

test('409: the second editor sees what changed and keeps their version', async ({ browser }) => {
  const { asha, bilal, groupId, expenseId } = await bothEditing(browser);

  await bilal.page.getByLabel('Amount', { exact: true }).fill('1,200');
  await bilal.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(bilal.page).toHaveURL(new RegExp(`/expenses/${expenseId}$`));

  await asha.page.getByLabel('What was it for?').fill('Dinner at Thalassa');
  await asha.page.getByRole('button', { name: 'Save changes' }).click();
  const panel = asha.page.getByRole('alert').filter({ hasText: 'Someone changed this expense while you were editing' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('row', { name: /Amount/ })).toContainText('₹1,200.00');
  await expect(panel.getByRole('row', { name: /Amount/ })).toContainText('₹1,000.00');
  await expect(panel.getByRole('row', { name: /What it was for/ })).toContainText('Dinner at Thalassa');

  await panel.getByRole('button', { name: 'Save my version' }).click();
  await expect(asha.page).toHaveURL(new RegExp(`/groups/${groupId}/expenses/${expenseId}$`));
  await expect(asha.page.getByRole('heading', { name: 'Dinner at Thalassa' })).toBeVisible();
  await expect(asha.page.getByText('Version 3.')).toBeVisible();
  await expect(asha.page.getByText('₹1,000.00').first()).toBeVisible();
  await asha.context.close();
  await bilal.context.close();
});

test('409: the second editor can take the saved version instead, then edit it', async ({ browser }) => {
  const { asha, bilal, expenseId } = await bothEditing(browser);

  await bilal.page.getByLabel('Amount', { exact: true }).fill('1,200');
  await bilal.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(bilal.page).toHaveURL(new RegExp(`/expenses/${expenseId}$`));

  await asha.page.getByLabel('Amount', { exact: true }).fill('900');
  await asha.page.getByRole('button', { name: 'Save changes' }).click();
  await asha.page.getByRole('button', { name: 'Use the saved version' }).click();
  await expect(asha.page.getByRole('alert').filter({ hasText: 'Someone changed' })).toHaveCount(0);
  await expect(asha.page.getByLabel('Amount', { exact: true })).toHaveValue('1,200.00');

  await asha.page.getByLabel('What was it for?').fill('Dinner, with dessert');
  await asha.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(asha.page.getByText('Version 3.')).toBeVisible();
  await asha.context.close();
  await bilal.context.close();
});
