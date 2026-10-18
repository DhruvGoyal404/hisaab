import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp, WEB_ORIGIN } from './helpers.js';

const { app, pool } = buildApp({ DEV_LOGIN: 'true', DATABASE_URL: inject('appDatabaseUrl') });
afterAll(() => pool.end());

type Agent = ReturnType<typeof request.agent>;
async function signIn(name: string): Promise<{ agent: Agent; userId: string }> {
  const agent = request.agent(app);
  const res = await agent.post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: `${name}-${randomUUID().slice(0, 8)}` });
  return { agent, userId: (res.body as { user: { id: string } }).user.id };
}
// Every write needs the Origin header; the browser sends it, tests set it.
const post = (a: Agent, url: string) => a.post(url).set('Origin', WEB_ORIGIN);
const put = (a: Agent, url: string) => a.put(url).set('Origin', WEB_ORIGIN);
const del = (a: Agent, url: string) => a.delete(url).set('Origin', WEB_ORIGIN);

let asha: Awaited<ReturnType<typeof signIn>>;
let bilal: Awaited<ReturnType<typeof signIn>>;
let groupId: string;
let ashaMember: string;
let bilalMember: string;

const equalSplit = (total: number, payer: string, ids: string[]) => ({
  description: 'Dinner', occurredOn: '2026-10-18', totalMinor: total,
  payers: [{ memberId: payer, paidMinor: total }],
  split: { method: 'equal', weights: ids.map((memberId) => ({ memberId, weight: 1 })) },
});

beforeAll(async () => {
  asha = await signIn('Asha');
  bilal = await signIn('Bilal');
  const created = await post(asha.agent, '/api/groups').send({ name: 'Goa' });
  expect(created.status).toBe(201);
  ({ groupId, memberId: ashaMember } = created.body as { groupId: string; memberId: string });
  const invite = await post(asha.agent, `/api/groups/${groupId}/invites`).send({});
  const token = (invite.body as { token: string }).token;
  const preview = await bilal.agent.get(`/api/invites/${token}`);
  expect(preview.body).toMatchObject({ groupName: 'Goa', ghostName: null, usable: true, alreadyMember: false });
  const accepted = await post(bilal.agent, `/api/invites/${token}/accept`);
  bilalMember = (accepted.body as { memberId: string }).memberId;
});

describe('groups and members', () => {
  it('GET /me and GET /groups', async () => {
    expect((await asha.agent.get('/api/me')).body).toEqual({ user: { id: asha.userId, name: expect.stringMatching(/^Asha-/) as string } });
    const groups = (await asha.agent.get('/api/groups')).body as { groups: { groupId: string }[]; totals: unknown[] };
    expect(groups.groups.map((g) => g.groupId)).toContain(groupId);
  });

  it('GET /groups/:id lists members with roles and marks me', async () => {
    const detail = (await bilal.agent.get(`/api/groups/${groupId}`)).body as {
      name: string; me: { memberId: string }; members: { memberId: string; role: string; isMe: boolean }[];
    };
    expect(detail.name).toBe('Goa');
    expect(detail.me.memberId).toBe(bilalMember);
    expect(detail.members.map((m) => [m.memberId, m.role, m.isMe]).sort()).toEqual(
      [[ashaMember, 'owner', false], [bilalMember, 'member', true]].sort(),
    );
  });

  it('adds a ghost and invites them by link', async () => {
    const ghost = await post(asha.agent, `/api/groups/${groupId}/ghosts`).send({ displayName: 'Chirag' });
    expect(ghost.status).toBe(201);
    const invite = await post(asha.agent, `/api/groups/${groupId}/invites`).send({ ghostMemberId: (ghost.body as { memberId: string }).memberId });
    const chirag = await signIn('Chirag');
    const preview = (await chirag.agent.get(`/api/invites/${(invite.body as { token: string }).token}`)).body as { ghostName: string };
    expect(preview.ghostName).toBe('Chirag');
  });

  it('PATCH settings, and 404 for outsiders', async () => {
    expect((await asha.agent.patch(`/api/groups/${groupId}`).set('Origin', WEB_ORIGIN).send({ simplifyDebts: false })).status).toBe(204);
    expect(((await asha.agent.get(`/api/groups/${groupId}`)).body as { simplifyDebts: boolean }).simplifyDebts).toBe(false);
    const mallory = await signIn('Mallory');
    expect((await mallory.agent.get(`/api/groups/${groupId}`)).status).toBe(404);
    expect((await mallory.agent.get(`/api/groups/${groupId}/balances`)).status).toBe(404);
    expect((await request(app).get('/api/groups')).status).toBe(401);
  });
});

describe('expenses over HTTP', () => {
  it('create with an idempotency key, replay, ETag, If-Match edit, 409, delete, restore', async () => {
    const key = randomUUID();
    const body = equalSplit(1000, ashaMember, [ashaMember, bilalMember]);
    const first = await post(asha.agent, `/api/groups/${groupId}/expenses`).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const again = await post(asha.agent, `/api/groups/${groupId}/expenses`).set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    const { expenseId } = first.body as { expenseId: string };
    expect((again.body as { expenseId: string }).expenseId).toBe(expenseId);

    const url = `/api/groups/${groupId}/expenses/${expenseId}`;
    const view = await bilal.agent.get(url);
    expect(view.headers.etag).toBe('"1"');
    expect((await put(bilal.agent, url).send(body)).status).toBe(428);
    const edited = await put(bilal.agent, url).set('If-Match', '"1"').send(equalSplit(1200, bilalMember, [ashaMember, bilalMember]));
    expect(edited.body).toEqual({ version: 2 });
    const stale = await put(asha.agent, url).set('If-Match', '1').send(body);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: 'version_conflict', details: { currentVersion: 2 } } });

    expect((await del(asha.agent, url).set('If-Match', '2')).body).toEqual({ version: 3 });
    expect(((await asha.agent.get(url)).body as { deleted: boolean }).deleted).toBe(true);
    expect((await post(asha.agent, `${url}/restore`).set('If-Match', '3')).body).toEqual({ version: 4 });
  });

  it('settles up and refuses to let someone with a balance leave', async () => {
    const balances = (await asha.agent.get(`/api/groups/${groupId}/balances`)).body as { members: { memberId: string; balanceMinor: number }[] };
    const owes = balances.members.find((m) => m.memberId === ashaMember)?.balanceMinor ?? 0;
    expect(owes).toBe(-600); // restored edit: Bilal paid 1200, split equally
    const leave = await post(asha.agent, `/api/groups/${groupId}/leave`);
    expect(leave.status).toBe(409);
    const s = await post(bilal.agent, `/api/groups/${groupId}/settlements`).set('Idempotency-Key', randomUUID())
      .send({ fromMemberId: ashaMember, toMemberId: bilalMember, amountMinor: 600 });
    expect(s.status).toBe(201);
    expect((await post(bilal.agent, `/api/groups/${groupId}/leave`)).status).toBe(204);
  });
});
