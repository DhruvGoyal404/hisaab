import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createExpense } from '../src/repo/expenses.js';
import { addGhost, createGroup, setSimplifyDebts } from '../src/repo/groups.js';
import { groupBalances } from '../src/repo/reads.js';
import type { Transfer } from '../src/settle/types.js';
import { appPool, expense } from './db/fixtures.js';
import { buildApp, WEB_ORIGIN } from './helpers.js';

const { app, pool: apiPool } = buildApp({ DEV_LOGIN: 'true', DATABASE_URL: inject('appDatabaseUrl') });
const pool = appPool();
afterAll(() => Promise.all([apiPool.end(), pool.end()]));

type Plan = { groupId: string; seq: number; mode: string; algorithm: string; k: number; transferCount: number; transfers: Transfer[] };

async function login(name: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name });
  return { agent, userId: (res.body as { user: { id: string } }).user.id };
}

let asha: Awaited<ReturnType<typeof login>>;
let groupId: string;
let m: Record<'A' | 'B' | 'C' | 'D' | 'E', string>;

beforeAll(async () => {
  asha = await login(`Asha-${Date.now()}`);
  const g = await createGroup(pool, { userId: asha.userId, name: 'Goa' });
  groupId = g.groupId;
  const ghost = (n: string) => addGhost(pool, { groupId, userId: asha.userId, displayName: n });
  m = { A: g.memberId, B: await ghost('B'), C: await ghost('C'), D: await ghost('D'), E: await ghost('E') };
  // seq: 1 group, 2-5 ghosts, 6-8 expenses. Balances in paise: A +300, B +200, C +200, D -400, E -300 (the greedy-needs-4, exact-needs-3 case).
  const add = (total: number, payer: string, participants: string[]) =>
    createExpense(pool, { groupId, userId: asha.userId, expense: expense(total, payer, participants) });
  await add(300, m.A, [m.E]);
  await add(200, m.B, [m.D]);
  await add(200, m.C, [m.D]);
});

const plan = async (mode?: string) => {
  const res = await asha.agent.get(`/api/groups/${groupId}/settle-plan${mode ? `?mode=${mode}` : ''}`);
  return { status: res.status, cache: res.headers['x-settle-plan-cache'], body: res.body as Plan };
};

async function zeroesBalances(transfers: Transfer[]): Promise<boolean> {
  const left = Object.fromEntries((await groupBalances(pool, { groupId, userId: asha.userId })).map((b) => [b.memberId, b.balanceMinor]));
  for (const t of transfers) {
    left[t.from] = (left[t.from] ?? 0) + t.amountMinor;
    left[t.to] = (left[t.to] ?? 0) - t.amountMinor;
  }
  return Object.values(left).every((v) => v === 0);
}

describe('GET /api/groups/:id/settle-plan', () => {
  it('requires a session', async () => {
    expect((await request(app).get(`/api/groups/${groupId}/settle-plan`)).status).toBe(401);
  });

  it('is 404 for someone outside the group and for a malformed id', async () => {
    const mallory = await login(`Mallory-${Date.now()}`);
    expect((await mallory.agent.get(`/api/groups/${groupId}/settle-plan`)).status).toBe(404);
    expect((await asha.agent.get('/api/groups/not-a-uuid/settle-plan')).status).toBe(404);
  });

  it('defaults to auto, which solves this group exactly in 3 transfers, and caches by last_seq', async () => {
    const first = await plan();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ groupId, seq: 8, mode: 'auto', algorithm: 'exact', k: 5, transferCount: 3 });
    expect(first.cache).toBe('miss');
    expect(await zeroesBalances(first.body.transfers)).toBe(true);
    const again = await plan();
    expect(again.cache).toBe('hit');
    expect(again.body).toEqual(first.body);
  });

  it('greedy needs 4, exact 3, raw 3 (one per expense)', async () => {
    const greedy = await plan('greedy');
    const exact = await plan('exact');
    const raw = await plan('raw');
    expect([greedy.body.algorithm, greedy.body.transferCount]).toEqual(['greedy', 4]);
    expect([exact.body.algorithm, exact.body.transferCount]).toEqual(['exact', 3]);
    expect([raw.body.algorithm, raw.body.transferCount]).toEqual(['raw', 3]);
    expect(raw.body.transfers).toEqual(expect.arrayContaining([
      { from: m.E, to: m.A, amountMinor: 300 },
      { from: m.D, to: m.B, amountMinor: 200 },
      { from: m.D, to: m.C, amountMinor: 200 },
    ]));
    for (const p of [greedy, exact, raw]) expect(await zeroesBalances(p.body.transfers)).toBe(true);
  });

  it('rejects an unknown mode with 400', async () => {
    expect((await plan('magic')).status).toBe(400);
  });

  it('recomputes after a new write (new last_seq) and follows the simplify setting', async () => {
    await createExpense(pool, { groupId, userId: asha.userId, expense: expense(100, m.E, [m.A]) });
    const after = await plan();
    expect(after.cache).toBe('miss');
    expect(after.body.seq).toBe(9);
    expect(await zeroesBalances(after.body.transfers)).toBe(true);

    await setSimplifyDebts(pool, { groupId, userId: asha.userId, simplifyDebts: false });
    const raw = await plan();
    expect(raw.body).toMatchObject({ mode: 'raw', algorithm: 'raw', seq: 10 });
    expect(await zeroesBalances(raw.body.transfers)).toBe(true);
  });
});
