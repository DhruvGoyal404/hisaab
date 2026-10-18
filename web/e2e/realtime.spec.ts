import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { apiFor, signedIn } from './support';

test('A adds an expense in the UI; B sees it without reloading', async ({ browser }) => {
  const asha = await signedIn(browser, 'Asha', { viewport: { width: 390, height: 844 } });
  const bilal = await signedIn(browser, 'Bilal', { viewport: { width: 1280, height: 860 } });
  const a = apiFor(asha.context.request);
  const { groupId } = await a.createGroup('Realtime check');
  const { token } = await a.invite(groupId);
  await apiFor(bilal.context.request).accept(token);

  await bilal.page.goto(`/groups/${groupId}`);
  await expect(bilal.page.getByTestId('connection-status')).toHaveAttribute('data-status', 'live');
  let reloads = 0;
  bilal.page.on('load', () => { reloads += 1; });

  await asha.page.goto(`/groups/${groupId}/expenses/new`);
  await asha.page.getByLabel('What was it for?').fill('Midnight maggi');
  await asha.page.getByLabel('Amount', { exact: true }).fill('180');
  const responded = asha.page.waitForResponse((r) => r.url().endsWith(`/api/groups/${groupId}/expenses`) && r.request().method() === 'POST');
  await asha.page.getByRole('button', { name: 'Add expense' }).click();
  await responded;
  const committedAt = performance.now();

  // B's activity and balances update in place.
  await expect(bilal.page.getByText('Midnight maggi')).toBeVisible({ timeout: 10_000 });
  const latencyMs = performance.now() - committedAt;
  await expect(bilal.page.getByText('owes ₹90.00')).toBeVisible();
  expect(reloads).toBe(0);
  test.info().annotations.push({ type: 'latency', description: `${latencyMs.toFixed(0)} ms from A's response to B's screen` });
  process.stdout.write(`[realtime e2e] A's POST response -> text on B's screen: ${latencyMs.toFixed(0)} ms\n`);

  await asha.context.close();
  await bilal.context.close();
});
