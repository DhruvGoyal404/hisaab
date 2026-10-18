import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const ORIGIN = 'http://localhost:5174';

type Ids = { groupId: string; members: Record<'asha' | 'bilal' | 'chirag' | 'dev', string> };

/** Contexts made by hand get baseURL explicitly rather than relying on config inheritance. */
export const contextOptions = (o: Parameters<Browser['newContext']>[0] = {}) => ({ baseURL: ORIGIN, ...o });

/** A signed-in browser context for `name` (dev sign-in through the API; the cookie lands in the context). */
export async function signedIn(browser: Browser, name: string, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page; userId: string }> {
  const context = await browser.newContext({ baseURL: ORIGIN, ...options });
  const res = await context.request.post('/api/dev/login', { data: { name }, headers: { Origin: ORIGIN } });
  expect(res.ok()).toBeTruthy();
  const userId = ((await res.json()) as { user: { id: string } }).user.id;
  return { context, page: await context.newPage(), userId };
}

/** Write helpers over the real API, sharing the context's session cookie. */
export function apiFor(request: APIRequestContext) {
  const post = async <T>(url: string, data: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const res = await request.post(url, { data, headers: { Origin: ORIGIN, ...headers } });
    if (!res.ok()) throw new Error(`${url} -> ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return {
    post,
    createGroup: (name: string) => post<{ groupId: string; memberId: string }>('/api/groups', { name }),
    addGhost: (groupId: string, displayName: string) => post<{ memberId: string }>(`/api/groups/${groupId}/ghosts`, { displayName }),
    invite: (groupId: string, ghostMemberId?: string) =>
      post<{ token: string }>(`/api/groups/${groupId}/invites`, ghostMemberId ? { ghostMemberId } : {}),
    accept: (token: string) => post<{ memberId: string }>(`/api/invites/${token}/accept`, {}),
    expense: (groupId: string, description: string, totalMinor: number, payer: string, participants: string[]) =>
      post<{ expenseId: string }>(`/api/groups/${groupId}/expenses`, {
        description, occurredOn: '2026-10-18', totalMinor,
        payers: [{ memberId: payer, paidMinor: totalMinor }],
        split: { method: 'equal', weights: participants.map((memberId) => ({ memberId, weight: 1 })) },
      }, { 'Idempotency-Key': randomUUID() }),
    settle: (groupId: string, from: string, to: string, amountMinor: number) =>
      post(`/api/groups/${groupId}/settlements`, { fromMemberId: from, toMemberId: to, amountMinor }, { 'Idempotency-Key': randomUUID() }),
    expenseCount: async (groupId: string): Promise<number> => {
      const res = await request.get(`/api/groups/${groupId}/activity?afterSeq=0&limit=200`);
      const body = (await res.json()) as { items: { type: string }[] };
      return body.items.filter((a) => a.type === 'expense.created').length;
    },
  };
}

export const unique = (base: string) => `${base} ${randomUUID().slice(0, 4)}`;

/**
 * A believable group: Asha (signed in) and Bilal (a second real user), plus Chirag and Dev added by
 * name, with a few dinners and cabs and one payment already made.
 */
export async function seedTrip(asha: APIRequestContext, bilal: APIRequestContext): Promise<Ids> {
  const a = apiFor(asha);
  const b = apiFor(bilal);
  const { groupId, memberId: ashaId } = await a.createGroup('Goa trip');
  const { token } = await a.invite(groupId);
  const { memberId: bilalId } = await b.accept(token);
  const { memberId: chiragId } = await a.addGhost(groupId, 'Chirag');
  const { memberId: devId } = await a.addGhost(groupId, 'Dev');
  const all = [ashaId, bilalId, chiragId, devId];
  await a.expense(groupId, 'Fish thali at Ritz Classic', 324000, ashaId, all);
  await b.expense(groupId, 'Scooter rental, 3 days', 180000, bilalId, all);
  await a.expense(groupId, 'Cab to the airport', 125050, ashaId, [ashaId, bilalId, chiragId]);
  await b.expense(groupId, 'Feni and snacks', 86500, bilalId, [bilalId, chiragId, devId]);
  await a.settle(groupId, devId, ashaId, 50000);
  return { groupId, members: { asha: ashaId, bilal: bilalId, chirag: chiragId, dev: devId } };
}
