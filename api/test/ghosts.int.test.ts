import { afterAll, describe, expect, it } from 'vitest';
import { createExpense, deleteExpense, editExpense, getExpense, restoreExpense } from '../src/repo/expenses.js';
import { acceptInvite, addGhost, createInvite, leaveGroup } from '../src/repo/groups.js';
import { activityFeed, groupBalances, userBalances } from '../src/repo/reads.js';
import { createSettlement } from '../src/repo/settlements.js';
import { appPool, balanceOf, expense, groupWithOwner, httpError, journalTotal, ledgerVsHeads, user } from './db/fixtures.js';

const pool = appPool();
afterAll(() => pool.end());

async function expectLedgerConsistent(groupId: string) {
  const { journal, heads } = await ledgerVsHeads(pool, groupId);
  expect(journal).toEqual(heads);
  expect(await journalTotal(pool, groupId)).toBe(0);
}

describe('claimer already in the group: merge', () => {
  it('keeps the ghost row linked to the real membership; expenses with lines for both stay valid', async () => {
    // Asha added "Bilal" as a placeholder; later the real Bilal joined through a plain link.
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool, 'Asha');
    const ghost = await addGhost(pool, { groupId, userId: owner, displayName: 'Bilal (placeholder)' });
    const bilal = await user(pool, 'Bilal');
    const plain = await createInvite(pool, { groupId, userId: owner });
    const { memberId: bilalMember } = await acceptInvite(pool, { token: plain.token, userId: bilal });

    // ₹30.00 paid by Asha, split equally between Asha, the real Bilal, and the placeholder.
    const { expenseId } = await createExpense(pool, { groupId, userId: owner, expense: expense(3000, asha, [asha, bilalMember, ghost]) });
    let b = await groupBalances(pool, { groupId, userId: owner });
    expect([balanceOf(b, asha), balanceOf(b, bilalMember), balanceOf(b, ghost)]).toEqual([2000, -1000, -1000]);

    // Bilal claims the placeholder while already a member: merge.
    const ghostInvite = await createInvite(pool, { groupId, userId: owner, ghostMemberId: ghost });
    const merged = await acceptInvite(pool, { token: ghostInvite.token, userId: bilal });
    expect(merged).toEqual({ groupId, memberId: bilalMember, outcome: 'merged' });

    const { rows } = await pool.query(
      'select user_id, display_name, status, merged_into from memberships where id = $1', [ghost]);
    expect(rows[0]).toEqual({ user_id: null, display_name: 'Bilal (placeholder)', status: 'merged', merged_into: bilalMember });

    // Balances fold the ghost into Bilal; the ghost no longer appears as its own member.
    b = await groupBalances(pool, { groupId, userId: owner });
    expect(b.map((x) => [x.memberId, x.balanceMinor])).toEqual([[asha, 2000], [bilalMember, -2000]]);
    expect((await userBalances(pool, { userId: bilal })).groups).toEqual([
      expect.objectContaining({ groupId, balanceMinor: -2000 }),
    ]);

    // The pre-merge expense is untouched and still has lines for both rows.
    const view = await getExpense(pool, { groupId, userId: bilal, expenseId });
    expect(view.lines.map((l) => l.memberId).sort()).toEqual([asha, bilalMember, ghost].sort());

    // Editing it while keeping lines for both the ghost and the real member is valid.
    await editExpense(pool, { groupId, userId: bilal, expenseId, expectedVersion: 1, expense: expense(3001, asha, [asha, bilalMember, ghost]) });
    b = await groupBalances(pool, { groupId, userId: owner });
    expect(balanceOf(b, asha)).toBe(-(balanceOf(b, bilalMember) ?? 0));
    expect([2000, 2001]).toContain(balanceOf(b, asha));
    await expectLedgerConsistent(groupId);

    // Delete and restore it.
    await deleteExpense(pool, { groupId, userId: bilal, expenseId, expectedVersion: 2 });
    b = await groupBalances(pool, { groupId, userId: owner });
    expect(b.every((x) => x.balanceMinor === 0)).toBe(true);
    await restoreExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 3 });
    expect((await getExpense(pool, { groupId, userId: owner, expenseId })).lines).toHaveLength(3);

    // A new expense may also carry lines for both rows.
    await createExpense(pool, { groupId, userId: owner, expense: expense(600, bilalMember, [bilalMember, ghost, asha]) });
    await expectLedgerConsistent(groupId);

    // The ghost is final: it can't be invited, claimed or merged again.
    expect((await httpError(createInvite(pool, { groupId, userId: owner, ghostMemberId: ghost }))).code).toBe('not_a_ghost');
    expect((await httpError(acceptInvite(pool, { token: ghostInvite.token, userId: bilal }))).status).toBe(410);

    // Leaving counts the merged ghost's balance too.
    expect((await httpError(leaveGroup(pool, { groupId, userId: bilal }))).code).toBe('balance_not_zero');
    b = await groupBalances(pool, { groupId, userId: owner });
    const owes = -(balanceOf(b, bilalMember) ?? 0);
    await createSettlement(pool, { groupId, userId: bilal, settlement: { fromMemberId: bilalMember, toMemberId: asha, amountMinor: owes } });
    await leaveGroup(pool, { groupId, userId: bilal });

    // Once Bilal has left, history involving his ghost is frozen too.
    expect((await httpError(deleteExpense(pool, { groupId, userId: owner, expenseId, expectedVersion: 4 }))).code).toBe('member_not_active');
    await expectLedgerConsistent(groupId);

    const feed = await activityFeed(pool, { groupId, userId: owner, limit: 50 });
    expect(feed.items.find((a) => a.type === 'member.merged')).toMatchObject({
      subjectId: bilalMember,
      payload: { ghostMemberId: ghost, ghostName: 'Bilal (placeholder)' },
    });
  });

  it('reactivates a claimer who had left, then merges', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool, 'Asha');
    const dev = await user(pool, 'Dev');
    const join = await createInvite(pool, { groupId, userId: owner });
    const { memberId: devMember } = await acceptInvite(pool, { token: join.token, userId: dev });
    await leaveGroup(pool, { groupId, userId: dev });

    const ghost = await addGhost(pool, { groupId, userId: owner, displayName: 'Dev' });
    await createExpense(pool, { groupId, userId: owner, expense: expense(800, asha, [asha, ghost]) });
    const claim = await createInvite(pool, { groupId, userId: owner, ghostMemberId: ghost });
    expect(await acceptInvite(pool, { token: claim.token, userId: dev })).toEqual({ groupId, memberId: devMember, outcome: 'merged' });

    const b = await groupBalances(pool, { groupId, userId: dev });
    expect(b.map((x) => [x.memberId, x.balanceMinor])).toEqual([[asha, 400], [devMember, -400]]);
  });
});

describe('claimer not in the group: claim', () => {
  it('the ghost row becomes theirs, with its history', async () => {
    const { groupId, owner, ownerMember: asha } = await groupWithOwner(pool, 'Asha');
    const ghost = await addGhost(pool, { groupId, userId: owner, displayName: 'Chirag' });
    await createExpense(pool, { groupId, userId: owner, expense: expense(1000, asha, [asha, ghost]) });

    const chirag = await user(pool, 'Chirag Real');
    const { token } = await createInvite(pool, { groupId, userId: owner, ghostMemberId: ghost });
    expect(await acceptInvite(pool, { token, userId: chirag })).toEqual({ groupId, memberId: ghost, outcome: 'claimed' });

    const b = await groupBalances(pool, { groupId, userId: chirag });
    expect(b.find((x) => x.memberId === ghost)).toEqual({ memberId: ghost, name: 'Chirag Real', isGhost: false, balanceMinor: -500 });
    expect((await userBalances(pool, { userId: chirag })).totals).toEqual([
      { currency: 'INR', owedToMeMinor: 0, iOweMinor: 500, netMinor: -500 },
    ]);
    await expectLedgerConsistent(groupId);
  });
});
