import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createExpense } from '../src/repo/expenses.js';
import { createGroup } from '../src/repo/groups.js';
import { appPool, expense } from './db/fixtures.js';
import { buildApp, WEB_ORIGIN } from './helpers.js';

const { app, pool: apiPool } = buildApp({ DEV_LOGIN: 'true', DATABASE_URL: inject('appDatabaseUrl') });
const pool = appPool();
afterAll(() => Promise.all([apiPool.end(), pool.end()]));

type Items = { items: { seq: number; type: string }[] };

let agent: ReturnType<typeof request.agent>;
let groupId: string;

beforeAll(async () => {
  agent = request.agent(app);
  const res = await agent.post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: `Asha-${Date.now()}` });
  const userId = (res.body as { user: { id: string } }).user.id;
  const g = await createGroup(pool, { userId, name: 'Goa' });
  groupId = g.groupId;
  for (let i = 1; i <= 5; i++) {
    await createExpense(pool, { groupId, userId, expense: expense(100 * i, g.memberId, [g.memberId]) });
  }
});

describe('GET /api/groups/:id/activity', () => {
  it('?afterSeq returns exactly the rows after it, oldest first, with lastSeq', async () => {
    const res = await agent.get(`/api/groups/${groupId}/activity?afterSeq=3`);
    expect(res.status).toBe(200);
    const body = res.body as Items & { lastSeq: number; hasMore: boolean };
    expect(body.items.map((a) => a.seq)).toEqual([4, 5, 6]);
    expect(body).toMatchObject({ lastSeq: 6, hasMore: false });
  });

  it('pages catch-up with limit and hasMore', async () => {
    const first = (await agent.get(`/api/groups/${groupId}/activity?afterSeq=0&limit=4`)).body as Items & { hasMore: boolean };
    expect(first.items.map((a) => a.seq)).toEqual([1, 2, 3, 4]);
    expect(first.hasMore).toBe(true);
    const rest = (await agent.get(`/api/groups/${groupId}/activity?afterSeq=4&limit=4`)).body as Items & { hasMore: boolean };
    expect(rest.items.map((a) => a.seq)).toEqual([5, 6]);
    expect(rest.hasMore).toBe(false);
  });

  it('is empty when the client is up to date', async () => {
    const body = (await agent.get(`/api/groups/${groupId}/activity?afterSeq=6`)).body as Items & { lastSeq: number };
    expect(body).toMatchObject({ items: [], lastSeq: 6 });
  });

  it('without afterSeq serves the newest-first feed', async () => {
    const body = (await agent.get(`/api/groups/${groupId}/activity?limit=2`)).body as Items & { nextBefore: number };
    expect(body.items.map((a) => a.seq)).toEqual([6, 5]);
    expect(body.nextBefore).toBe(5);
  });

  it('rejects bad cursors and is 401/404 for outsiders', async () => {
    expect((await agent.get(`/api/groups/${groupId}/activity?afterSeq=1&before=3`)).status).toBe(400);
    expect((await agent.get(`/api/groups/${groupId}/activity?afterSeq=-1`)).status).toBe(400);
    expect((await agent.get(`/api/groups/${groupId}/activity?afterSeq=0&limit=500`)).status).toBe(422);
    expect((await request(app).get(`/api/groups/${groupId}/activity?afterSeq=0`)).status).toBe(401);
    const stranger = request.agent(app);
    await stranger.post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: `Mallory-${Date.now()}` });
    expect((await stranger.get(`/api/groups/${groupId}/activity?afterSeq=0`)).status).toBe(404);
  });
});
