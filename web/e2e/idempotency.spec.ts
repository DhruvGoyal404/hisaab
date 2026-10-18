import { expect, test, type Page } from '@playwright/test';
import { apiFor, signedIn } from './support';

async function openNewExpense(page: Page, groupId: string) {
  await page.goto(`/groups/${groupId}/expenses/new`);
  await page.getByLabel('What was it for?').fill('Chai and samosa');
  await page.getByLabel('Amount', { exact: true }).fill('240');
}

test('double-clicking “Add expense” records exactly one expense', async ({ browser }) => {
  const asha = await signedIn(browser, 'Asha');
  const api = apiFor(asha.context.request);
  const { groupId } = await api.createGroup('Idempotency, double click');
  await api.addGhost(groupId, 'Bilal');

  const posts: string[] = [];
  asha.page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/groups/${groupId}/expenses`)) posts.push(r.headers()['idempotency-key'] ?? '');
  });
  await openNewExpense(asha.page, groupId);
  await asha.page.getByRole('button', { name: 'Add expense' }).dblclick();
  await expect(asha.page).toHaveURL(new RegExp(`/groups/${groupId}$`));

  expect(await api.expenseCount(groupId)).toBe(1);
  expect(posts.length).toBeGreaterThanOrEqual(1);
  expect(new Set(posts).size).toBe(1); // whatever reached the network carried one key
  await asha.context.close();
});

test('a retry after a lost response reuses the key and still records one expense', async ({ browser }) => {
  const asha = await signedIn(browser, 'Asha');
  const api = apiFor(asha.context.request);
  const { groupId } = await api.createGroup('Idempotency, lost response');

  // The first request reaches the server and commits, but its response never reaches the page.
  const keys: string[] = [];
  let replayStatus = 0;
  await asha.page.route(`**/api/groups/${groupId}/expenses`, async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (keys.length === 1) {
      await route.fetch();
      await route.abort('connectionreset');
      return;
    }
    const res = await route.fetch();
    replayStatus = res.status();
    await route.fulfill({ response: res });
  });

  await openNewExpense(asha.page, groupId);
  const submit = asha.page.getByRole('button', { name: 'Add expense' });
  await submit.click();
  await expect(asha.page.getByRole('alert').filter({ hasText: 'Check your connection' })).toBeVisible();
  expect(await api.expenseCount(groupId)).toBe(1); // it did commit

  await submit.click(); // the person tries again
  await expect(asha.page).toHaveURL(new RegExp(`/groups/${groupId}$`));
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(replayStatus).toBe(200); // the server replayed the first result instead of creating another
  expect(await api.expenseCount(groupId)).toBe(1);
  await asha.context.close();
});
