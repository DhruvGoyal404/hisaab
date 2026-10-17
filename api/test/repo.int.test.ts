import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createExpense, deleteExpense, editExpense, getExpense, restoreExpense } from '../src/repo/expenses.js';
import { acceptInvite, addGhost, createInvite } from '../src/repo/groups.js';
import { activityFeed, groupBalances, userBalances } from '../src/repo/reads.js';
import { createSettlement } from '../src/repo/settlements.js';
import { appPool, balanceOf, expense, groupWithOwner, httpError, journalTotal, user } from './db/fixtures.js';

const pool = appPool();
afterAll(() => pool.end());

async function threePeople() {
  const g = await groupWithOwner(pool, 'Asha');
  const bilal = await user(pool, 'Bilal');
  const invite = await createInvite(pool, { groupId: g.groupId, userId: g.owner });
  const joined = await acceptInvite(pool, { token: invite.token, userId: bilal });
  const chirag = await addGhost(pool, { groupId: g.groupId, userId: g.owner, displayName: 'Chirag' });
  return { ...g, bilal, bilalMember: joined.memberId, chirag };
}

describe('expense lifecycle', () => {
  it('create → edit → delete → restore keeps balances and the journal consistent', async () => {
    const { groupId, owner, ownerMember: asha, bilalMember: bilal, chirag } = await threePeople();
    const balances = async () => groupBalances(pool, { groupId, userId: owner });

    // ₹10.00 paid by Asha at 33.33/33.33/33.34%.
    const created = await createExpense(pool, {
      groupId, userId: owner, expense: expense(1000, asha, [asha, bilal, chirag], 'percent', [3333, 3333, 3334]),
    });
    expect(created).toMatchObject({ version: 1, replayed: false });
    let b = await balances();
    expect([balanceOf(b, asha), balanceOf(b, bilal), balanceOf(b, chirag)]).toEqual([667, -333, -334]);

    // Edit: ₹9.00 paid by Bilal, equal between Asha and Bilal.
    const edited = await editExpense(pool, {
      groupId, userId: owner, expenseId: created.expenseId, expectedVersion: 1, expense: expense(900, bilal, [asha, bilal]),
    });
    expect(edited.version).toBe(2);
    b = await balances();
    expect([balanceOf(b, asha), balanceOf(b, bilal), balanceOf(b, chirag)]).toEqual([-450, 450, 0]);

    await deleteExpense(pool, { groupId, userId: owner, expenseId: created.expenseId, expectedVersion: 2 });
    b = await balances();
    expect(b.every((x) => x.balanceMinor === 0)).toBe(true);
    const deleted = await getExpense(pool, { groupId, userId: owner, expenseId: created.expenseId });
    expect(deleted).toMatchObject({ version: 3, deleted: true, totalMinor: 900 });

    const restored = await restoreExpense(pool, { groupId, userId: owner, expenseId: created.expenseId, expectedVersion: 3 });
    expect(restored.version).toBe(4);
    b = await balances();
    expect([balanceOf(b, asha), balanceOf(b, bilal)]).toEqual([-450, 450]);
    const view = await getExpense(pool, { groupId, userId: owner, expenseId: created.expenseId });
    expect(view).toMatchObject({ version: 4, deleted: false, totalMinor: 900, splitMethod: 'equal' });
    expect(view.lines.map((l) => l.owedMinor).sort()).toEqual([450, 450]);

    expect(await journalTotal(pool, groupId)).toBe(0);
  });

  it('rejects a stale expectedVersion with 409 and the current version', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    const { expenseId } = await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]) });
    await editExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 1, expense: expense(600, asha, [asha]) });
    const err = await httpError(editExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 1, expense: expense(700, asha, [asha]) }));
    expect(err).toMatchObject({ status: 409, code: 'version_conflict', details: { currentVersion: 2 } });
  });

  it('refuses to edit a deleted expense, delete twice, or restore a live one', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    const { expenseId } = await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]) });
    expect((await httpError(restoreExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 1 }))).code).toBe('not_deleted');
    await deleteExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 1 });
    expect((await httpError(deleteExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 2 }))).code).toBe('already_deleted');
    expect((await httpError(editExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 2, expense: expense(1, asha, [asha]) }))).code)
      .toBe('expense_deleted');
  });

  it('validates input before touching the ledger', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    const other = await groupWithOwner(pool, 'Zoya');
    const bad = (e: ReturnType<typeof expense>) => httpError(createExpense(pool, { groupId, userId: owner, expense: e }));
    expect((await bad({ ...expense(1000, asha, [asha]), payers: [{ memberId: asha, paidMinor: 999 }] })).code).toBe('payers_mismatch');
    expect((await bad(expense(1000, asha, [asha], 'percent', [9999]))).code).toBe('invalid_split');
    expect((await bad(expense(0, asha, [asha]))).code).toBe('invalid_total');
    expect((await bad(expense(1000, asha, [asha, other.ownerMember]))).code).toBe('unknown_member');
  });
});

describe('settlements and balances', () => {
  it('settling up brings everyone to zero; user balances span groups', async () => {
    const { groupId, owner, ownerMember: asha, bilal, bilalMember } = await threePeople();
    await createExpense(pool, { groupId, userId: owner, expense: expense(1001, asha, [asha, bilalMember]) });
    let b = await groupBalances(pool, { groupId, userId: owner });
    const bilalOwes = -(balanceOf(b, bilalMember) ?? 0);
    expect(bilalOwes).toBeGreaterThanOrEqual(500);
    expect(bilalOwes).toBeLessThanOrEqual(501);

    const second = await groupWithOwner(pool, 'Dev');
    const inv = await createInvite(pool, { groupId: second.groupId, userId: second.owner });
    const inSecond = await acceptInvite(pool, { token: inv.token, userId: bilal });
    await createExpense(pool, { groupId: second.groupId, userId: second.owner, expense: expense(300, inSecond.memberId, [second.ownerMember, inSecond.memberId]) });

    const before = await userBalances(pool, { userId: bilal });
    expect(before.groups).toHaveLength(2);
    expect(before.totals).toEqual([{ currency: 'INR', owedToMeMinor: 150, iOweMinor: bilalOwes, netMinor: 150 - bilalOwes }]);

    await createSettlement(pool, { groupId, userId: bilal, settlement: { fromMemberId: bilalMember, toMemberId: asha, amountMinor: bilalOwes } });
    b = await groupBalances(pool, { groupId, userId: owner });
    expect(b.every((x) => x.balanceMinor === 0)).toBe(true);
    expect(await journalTotal(pool, groupId)).toBe(0);
  });

  it('replays a settlement with the same idempotency key', async () => {
    const { groupId, owner, ownerMember: asha, bilalMember } = await threePeople();
    const key = randomUUID();
    const s = { fromMemberId: bilalMember, toMemberId: asha, amountMinor: 250 };
    const first = await createSettlement(pool, { groupId, userId: owner, settlement: s, idempotencyKey: key });
    const again = await createSettlement(pool, { groupId, userId: owner, settlement: s, idempotencyKey: key });
    expect(again).toEqual({ settlementId: first.settlementId, replayed: true });
    expect(balanceOf(await groupBalances(pool, { groupId, userId: owner }), asha)).toBe(-250);
  });
});

describe('idempotent expense creation', () => {
  it('replays the same request and rejects a different body under the same key', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    const key = randomUUID();
    const first = await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]), idempotencyKey: key });
    const again = await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]), idempotencyKey: key });
    expect(again).toEqual({ expenseId: first.expenseId, version: 1, replayed: true });
    const err = await httpError(createExpense(pool, { groupId, userId: owner, expense: expense(501, asha, [asha]), idempotencyKey: key }));
    expect(err.code).toBe('idempotency_key_reused');
  });

  it('a replayed request leaves no gap in the group sequence', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    const key = randomUUID();
    await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]), idempotencyKey: key });
    await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]), idempotencyKey: key });
    const { rows } = await pool.query<{ last_seq: number; activities: number }>(
      'select last_seq, (select count(*)::int from activity_log where group_id = $1) as activities from groups where id = $1',
      [groupId],
    );
    expect(rows[0]).toEqual({ last_seq: 2, activities: 2 });
  });
});

describe('activity feed', () => {
  it('pages newest-first with a seq cursor', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    for (let i = 1; i <= 5; i++) {
      await createExpense(pool, { groupId, userId: owner, expense: expense(100 * i, asha, [asha]) });
    }
    const page1 = await activityFeed(pool, { groupId, userId: owner, limit: 4 });
    expect(page1.items.map((a) => a.seq)).toEqual([6, 5, 4, 3]);
    expect(page1.nextBefore).toBe(3);
    expect(page1.items[0]).toMatchObject({ type: 'expense.created', actorName: 'Asha', payload: { totalMinor: 500 } });
    const page2 = await activityFeed(pool, { groupId, userId: owner, limit: 4, before: page1.nextBefore ?? 0 });
    expect(page2.items.map((a) => [a.seq, a.type])).toEqual([[2, 'expense.created'], [1, 'group.created']]);
    expect(page2.nextBefore).toBeNull();
  });
});

describe('authorization', () => {
  it('returns 404 to non-members for reads and writes, and for another group\'s expense', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool);
    const { expenseId } = await createExpense(pool, { groupId, userId: owner, expense: expense(500, asha, [asha]) });
    const stranger = await groupWithOwner(pool, 'Mallory');
    const as = { groupId, userId: stranger.owner };
    expect((await httpError(groupBalances(pool, as))).status).toBe(404);
    expect((await httpError(activityFeed(pool, as))).status).toBe(404);
    expect((await httpError(getExpense(pool, { ...as, expenseId }))).status).toBe(404);
    expect((await httpError(createExpense(pool, { ...as, expense: expense(1, asha, [asha]) }))).status).toBe(404);
    expect((await httpError(deleteExpense(pool, { ...as, expenseId, expectedVersion: 1 }))).status).toBe(404);
    // Mallory's own group, Asha's expense id.
    expect((await httpError(getExpense(pool, { groupId: stranger.groupId, userId: stranger.owner, expenseId }))).status).toBe(404);
    expect((await httpError(groupBalances(pool, { groupId: 'not-a-uuid', userId: owner }))).status).toBe(404);
  });
});
