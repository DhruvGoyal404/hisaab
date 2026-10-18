import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN } from './helpers.js';
import { startStack } from './realtime/harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

type User = { cookie: string; userId: string };
type Balance = { memberId: string; name: string; isGhost: boolean; balanceMinor: number };

const send = (method: 'post' | 'delete', user: User, url: string) =>
  request(stack.app)[method](url).set('Origin', WEB_ORIGIN).set('Cookie', user.cookie);
const get = (user: User, url: string) => request(stack.app).get(url).set('Cookie', user.cookie);

/** A group owned by `owner` with `others` joined through invites; returns member ids by user id. */
async function groupOf(owner: User, others: User[], ghosts: string[] = []) {
  const created = (await send('post', owner, '/api/groups').send({ name: 'Goa' }).expect(201)).body as { groupId: string; memberId: string };
  const members: Record<string, string> = { [owner.userId]: created.memberId };
  for (const u of others) {
    const { token } = (await send('post', owner, `/api/groups/${created.groupId}/invites`).send({}).expect(201)).body as { token: string };
    members[u.userId] = ((await send('post', u, `/api/invites/${token}/accept`).expect(200)).body as { memberId: string }).memberId;
  }
  for (const displayName of ghosts) await send('post', owner, `/api/groups/${created.groupId}/ghosts`).send({ displayName }).expect(201);
  return { groupId: created.groupId, members };
}

async function expense(by: User, groupId: string, payer: string, totalMinor: number, among: string[]) {
  await send('post', by, `/api/groups/${groupId}/expenses`).send({
    description: 'Dinner', occurredOn: '2026-10-19', totalMinor,
    payers: [{ memberId: payer, paidMinor: totalMinor }],
    split: { method: 'equal', weights: among.map((memberId) => ({ memberId, weight: 1 })) },
  }).expect(201);
}

const balances = async (viewer: User, groupId: string) =>
  ((await get(viewer, `/api/groups/${groupId}/balances`).expect(200)).body as { members: Balance[] }).members;

const unique = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const threeUsers = async (): Promise<[User, User, User]> =>
  [await stack.login(unique('Asha')), await stack.login(unique('Bilal')), await stack.login(unique('Chirag'))];

describe('account deletion', () => {
  it('turns memberships into placeholders and leaves every balance exactly where it was', async () => {
    const [asha, bilal, chirag] = await threeUsers();
    const g = await groupOf(asha, [bilal, chirag]);
    const m = (u: User) => g.members[u.userId] ?? '';
    await expense(asha, g.groupId, m(asha), 90_001, [m(asha), m(bilal), m(chirag)]);
    await expense(bilal, g.groupId, m(bilal), 30_000, [m(asha), m(bilal)]);
    // A second group, so deletion has more than one group to rewrite.
    const g2 = await groupOf(bilal, [chirag]);
    await expense(chirag, g2.groupId, g2.members[chirag.userId] ?? '', 5_000, Object.values(g2.members));

    const before = await balances(asha, g.groupId);
    const before2 = await balances(chirag, g2.groupId);
    await stack.pool.query(
      `insert into oauth_identities (user_id, provider, subject, email, email_verified) values ($1, 'github', $2, null, true)`,
      [bilal.userId, unique('gh')],
    );
    const socket = stack.socket({ cookie: bilal.cookie });
    await stack.ready(socket);
    const gone = new Promise<string>((resolve) => socket.once('disconnect', resolve));

    expect((await send('delete', bilal, '/api/me').send({})).status).toBe(400); // needs { confirm: true }
    const res = await send('delete', bilal, '/api/me').send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, groups: 2 });
    expect(res.headers['set-cookie']?.toString()).toMatch(/hisaab_session=;/);

    // Same member ids, same amounts; Bilal's row is now a placeholder. Both groups still sum to zero.
    const after = await balances(asha, g.groupId);
    expect(after.map(({ memberId, balanceMinor }) => ({ memberId, balanceMinor })))
      .toEqual(before.map(({ memberId, balanceMinor }) => ({ memberId, balanceMinor })));
    expect(after.find((b) => b.memberId === m(bilal))).toMatchObject({ name: 'Deleted user', isGhost: true });
    expect(after.reduce((s, b) => s + b.balanceMinor, 0)).toBe(0);
    const after2 = await balances(chirag, g2.groupId);
    expect(after2.map((b) => b.balanceMinor)).toEqual(before2.map((b) => b.balanceMinor));
    expect(after2.reduce((s, b) => s + b.balanceMinor, 0)).toBe(0);
    const { rows: [ledger] } = await stack.pool.query<{ sum: string }>(
      'select coalesce(sum(delta_minor), 0)::text as sum from ledger_entries le join memberships m on m.id = le.member_id where m.group_id = any($1::uuid[])',
      [[g.groupId, g2.groupId]],
    );
    expect(ledger?.sum).toBe('0');

    // Signed out everywhere, sockets included; nothing left to sign in with; the row is anonymous.
    expect(await gone).toBe('io server disconnect');
    expect((await get(bilal, '/api/me')).status).toBe(401);
    const { rows: [left] } = await stack.pool.query<{ sessions: string; identities: string; email: string | null; display_name: string; deleted: boolean }>(
      `select (select count(*) from sessions where user_id = u.id)::text as sessions,
              (select count(*) from oauth_identities where user_id = u.id)::text as identities,
              u.email, u.display_name, u.deleted_at is not null as deleted
         from users u where u.id = $1`,
      [bilal.userId],
    );
    expect(left).toEqual({ sessions: '0', identities: '0', email: null, display_name: 'Deleted user', deleted: true });

    // The group's history says what happened, and the others can carry on as before.
    const feed = (await get(asha, `/api/groups/${g.groupId}/activity`).expect(200)).body as { items: { type: string; subjectId: string }[] };
    expect(feed.items[0]).toMatchObject({ type: 'member.deleted_account', subjectId: m(bilal) });
    await expense(chirag, g.groupId, m(chirag), 1_000, [m(bilal), m(chirag)]);
    expect((await balances(asha, g.groupId)).reduce((s, b) => s + b.balanceMinor, 0)).toBe(0);
  });

  it('passes ownership on (admins first, else the longest-standing member) and numbers clashing names', async () => {
    const [asha, bilal, chirag] = await threeUsers();
    const g = await groupOf(asha, [bilal, chirag], ['Deleted user']);
    await send('delete', asha, '/api/me').send({ confirm: true }).expect(200);

    const detail = (await get(bilal, `/api/groups/${g.groupId}`).expect(200)).body as {
      members: { memberId: string; name: string; role: string; isGhost: boolean }[];
    };
    const byId = new Map(detail.members.map((x) => [x.memberId, x]));
    expect(byId.get(g.members[bilal.userId] ?? '')?.role).toBe('owner');
    expect(byId.get(g.members[chirag.userId] ?? '')?.role).toBe('member');
    expect(byId.get(g.members[asha.userId] ?? '')).toMatchObject({ name: 'Deleted user 2', role: 'member', isGhost: true });
  });

  it('the database refuses to detach a membership from a user whose account still exists', async () => {
    const asha = await stack.login(unique('Asha'));
    const g = await groupOf(asha, []);
    await expect(stack.pool.query(
      `update memberships set user_id = null, display_name = 'Nobody', role = 'member' where id = $1`,
      [g.members[asha.userId]],
    )).rejects.toMatchObject({ code: 'ZM004' });
  });
});
