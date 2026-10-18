// Database-enforced invariants, exercised through raw SQL as the app role (the API's privileges)
// and, where it matters, as the owner role. The repository layer is used only to set up state.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createExpense, editExpense } from '../src/repo/expenses.js';
import { acceptInvite, addGhost, createInvite, leaveGroup } from '../src/repo/groups.js';
import { createSettlement } from '../src/repo/settlements.js';
import { appPool, expense, groupWithOwner, httpError, ledgerVsHeads, ownerPool, sqlState, user } from './db/fixtures.js';

const app = appPool();
const owner = ownerPool();
afterAll(() => Promise.all([app.end(), owner.end()]));

/** Runs `fn` in a transaction that took the group lock and wrote its activity row, then commits. */
async function lockedWrite(groupId: string, actor: string, fn: (c: pg.PoolClient, seq: number) => Promise<unknown>): Promise<void> {
  const c = await app.connect();
  try {
    await c.query('begin');
    const { rows } = await c.query<{ last_seq: number }>('update groups set last_seq = last_seq + 1 where id = $1 returning last_seq', [groupId]);
    const seq = rows[0]?.last_seq ?? 0;
    await c.query(`insert into activity_log (group_id, seq, actor_user_id, type) values ($1, $2, $3, 'test.write')`, [groupId, seq, actor]);
    await fn(c, seq);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback');
    throw err;
  } finally {
    c.release();
  }
}

/** A raw expense insert: version 1 with the given (member, paid, owed, weight) lines. */
function rawExpense(groupId: string, actor: string, total: number, method: string, lines: [string, number, number, number | null][]) {
  const expenseId = randomUUID();
  return lockedWrite(groupId, actor, async (c, seq) => {
    await c.query('insert into expenses (id, group_id, created_seq) values ($1, $2, $3)', [expenseId, groupId, seq]);
    await c.query(
      `insert into expense_versions (expense_id, version, group_id, currency, kind, description, total_minor, split_method, occurred_on, author_user_id, seq)
       values ($1, 1, $2, 'INR', 'create', 'raw', $3, $4, '2026-10-18', $5, $6)`,
      [expenseId, groupId, total, method, actor, seq],
    );
    for (const [member, paid, owed, weight] of lines) {
      await c.query(
        `insert into expense_lines (expense_id, version, group_id, member_id, paid_minor, owed_minor, weight) values ($1, 1, $2, $3, $4, $5, $6)`,
        [expenseId, groupId, member, paid, owed, weight],
      );
    }
  });
}

async function twoMembers() {
  const g = await groupWithOwner(app, 'Asha');
  const ghost = await addGhost(app, { groupId: g.groupId, userId: g.owner, displayName: 'Bilal' });
  const ghost2 = await addGhost(app, { groupId: g.groupId, userId: g.owner, displayName: 'Chirag' });
  return { ...g, a: g.ownerMember, b: ghost, c: ghost2 };
}

describe('splits must sum to the total (deferred check at COMMIT)', () => {
  it('accepts a correct raw insert', async () => {
    const { groupId, owner: actor, a, b } = await twoMembers();
    await rawExpense(groupId, actor, 1000, 'exact', [[a, 1000, 500, 500], [b, 0, 500, 500]]);
  });

  // [label, total, method, lines as [member index, paid, owed, weight]]
  it.each([
    ['owed sums to 999', 1000, 'exact', [[0, 1000, 500, 500], [1, 0, 499, 499]]],
    ['paid sums to 999', 1000, 'exact', [[0, 999, 500, 500], [1, 0, 500, 500]]],
    ['a share outside floor/ceil (298/300/302 of 900)', 900, 'equal', [[0, 900, 298, 1], [1, 0, 300, 1], [2, 0, 302, 1]]],
    ['percent weights not summing to 10000', 1000, 'percent', [[0, 1000, 500, 5000], [1, 0, 500, 4999]]],
    ['exact weight differing from owed', 1000, 'exact', [[0, 1000, 600, 500], [1, 0, 400, 500]]],
    ['equal split with weight 2', 1000, 'equal', [[0, 1000, 500, 2], [1, 0, 500, 1]]],
    ['no participants', 1000, 'equal', [[0, 1000, 0, null]]],
  ] as const)('rejects %s with ZL002', async (_label, total, method, spec) => {
    const { groupId, owner: actor, a, b, c } = await twoMembers();
    const ids = [a, b, c];
    const lines = spec.map(([i, paid, owed, w]) => [ids[i] ?? '', paid, owed, w] as [string, number, number, number | null]);
    expect(await sqlState(rawExpense(groupId, actor, total, method, lines))).toBe('ZL002');
  });

  it('rejects lines on a delete version', async () => {
    const { groupId, owner: actor, a } = await twoMembers();
    const { expenseId } = await createExpense(app, { groupId, userId: actor, expense: expense(100, a, [a]) });
    const state = await sqlState(lockedWrite(groupId, actor, async (c, seq) => {
      await c.query(
        `insert into expense_versions (expense_id, version, group_id, currency, kind, author_user_id, seq) values ($1, 2, $2, 'INR', 'delete', $3, $4)`,
        [expenseId, groupId, actor, seq],
      );
      await c.query(
        `insert into expense_lines (expense_id, version, group_id, member_id, paid_minor, owed_minor, weight) values ($1, 2, $2, $3, 100, 100, 1)`,
        [expenseId, groupId, a],
      );
    }));
    expect(state).toBe('ZL002');
  });
});

/**
 * TRUNCATE ... CASCADE needs ACCESS EXCLUSIVE locks on the table and everything referencing it, in
 * a database other test files are writing to concurrently. A short lock_timeout makes it give up
 * (55P03) long before deadlock detection (1 s) could pick a victim, so it never takes another
 * file's transaction down with it; it may still lose a deadlock (40P01) itself. Retry those
 * transient lock failures; the assertion is still that the trigger itself rejects it.
 */
async function truncateWithLockTimeout(table: string): Promise<unknown> {
  const c = await owner.connect();
  try {
    await c.query("set lock_timeout = '100ms'");
    return await c.query(`truncate ${table} cascade`);
  } finally {
    await c.query('reset lock_timeout').catch(() => undefined);
    c.release();
  }
}

async function ownerTruncateState(table: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const state = await sqlState(truncateWithLockTimeout(table));
    if ((state !== '40P01' && state !== '55P03') || attempt === 29) return state;
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
}

const APPEND_ONLY = ['activity_log', 'expenses', 'expense_versions', 'expense_lines', 'settlements', 'settlement_voids', 'ledger_entries'];

describe('append-only tables', () => {
  async function populatedGroup() {
    const { groupId, owner: actor, a, b } = await twoMembers();
    await createExpense(app, { groupId, userId: actor, expense: expense(1000, a, [a, b]) });
    const { settlementId } = await createSettlement(app, { groupId, userId: actor, settlement: { fromMemberId: b, toMemberId: a, amountMinor: 100 } });
    await lockedWrite(groupId, actor, (c, seq) =>
      c.query('insert into settlement_voids (settlement_id, group_id, author_user_id, seq) values ($1, $2, $3, $4)', [settlementId, groupId, actor, seq]));
    return groupId;
  }

  it.each(APPEND_ONLY)('the app role cannot UPDATE, DELETE or TRUNCATE %s', async (table) => {
    const groupId = await populatedGroup();
    expect(await sqlState(app.query(`update ${table} set group_id = group_id where group_id = $1`, [groupId]))).toBe('42501');
    expect(await sqlState(app.query(`delete from ${table} where group_id = $1`, [groupId]))).toBe('42501');
    expect(await sqlState(app.query(`truncate ${table} cascade`))).toBe('42501');
  });

  it('the app role cannot write the journal directly', async () => {
    const { groupId, a } = await twoMembers();
    expect(await sqlState(app.query(
      `insert into ledger_entries (group_id, seq, member_id, delta_minor, source, settlement_id) values ($1, 1, $2, 1, 'settlement', $3)`,
      [groupId, a, randomUUID()],
    ))).toBe('42501');
  });

  it.each(APPEND_ONLY)('even the owner role is stopped by the trigger on %s (ZA001)', async (table) => {
    const groupId = await populatedGroup();
    // A real change for every table (the expenses guard only rejects actual changes).
    const [col, value] = table === 'expenses' ? ['created_at', 'now()'] : table === 'activity_log' ? ['type', "'x.y'"] : ['group_id', 'group_id'];
    expect(await sqlState(owner.query(`update ${table} set ${col} = ${value} where group_id = $1`, [groupId]))).toBe('ZA001');
    expect(await sqlState(owner.query(`delete from ${table} where group_id = $1`, [groupId]))).toBe('ZA001');
    expect(await ownerTruncateState(table)).toBe('ZA001');
  });
});

describe('writes must hold the group lock and use its current seq', () => {
  it('rejects an activity row without bumping the sequence (ZS001)', async () => {
    const { groupId, owner: actor } = await twoMembers();
    const { rows } = await app.query<{ last_seq: number }>('select last_seq from groups where id = $1', [groupId]);
    const next = (rows[0]?.last_seq ?? 0) + 1;
    expect(await sqlState(app.query(
      `insert into activity_log (group_id, seq, actor_user_id, type) values ($1, $2, $3, 'test.write')`, [groupId, next, actor],
    ))).toBe('ZS001');
  });

  it('rejects ledger writes stamped with a stale seq (ZS001)', async () => {
    const { groupId, owner: actor, a, b } = await twoMembers();
    const state = await sqlState(lockedWrite(groupId, actor, (c, seq) =>
      c.query(
        `insert into settlements (group_id, currency, from_member_id, to_member_id, amount_minor, author_user_id, seq) values ($1, 'INR', $2, $3, 1, $4, $5)`,
        [groupId, a, b, actor, seq - 1],
      )));
    expect(state).toBe('ZS001');
  });

  it('rejects adding lines to a version from a later transaction (ZS001)', async () => {
    const { groupId, owner: actor, a, b } = await twoMembers();
    const { expenseId } = await createExpense(app, { groupId, userId: actor, expense: expense(100, a, [a]) });
    const state = await sqlState(lockedWrite(groupId, actor, (c) =>
      c.query(
        `insert into expense_lines (expense_id, version, group_id, member_id, paid_minor, owed_minor, weight) values ($1, 1, $2, $3, 0, 0, 1)`,
        [expenseId, groupId, b],
      )));
    expect(state).toBe('ZS001');
  });

  it('rejects an out-of-order version straight from the trigger (ZV001)', async () => {
    const { groupId, owner: actor, a } = await twoMembers();
    const { expenseId } = await createExpense(app, { groupId, userId: actor, expense: expense(100, a, [a]) });
    const state = await sqlState(lockedWrite(groupId, actor, (c, seq) =>
      c.query(
        `insert into expense_versions (expense_id, version, group_id, currency, kind, author_user_id, seq) values ($1, 3, $2, 'INR', 'delete', $3, $4)`,
        [expenseId, groupId, actor, seq],
      )));
    expect(state).toBe('ZV001');
  });
});

describe('leaving a group', () => {
  it('is refused with a non-zero balance and allowed after settling up', async () => {
    const g = await groupWithOwner(app, 'Asha');
    const bilal = await user(app, 'Bilal');
    const { token } = await createInvite(app, { groupId: g.groupId, userId: g.owner });
    const { memberId: b } = await acceptInvite(app, { token, userId: bilal });
    await createExpense(app, { groupId: g.groupId, userId: g.owner, expense: expense(1000, g.ownerMember, [g.ownerMember, b]) });

    expect(await httpError(leaveGroup(app, { groupId: g.groupId, userId: bilal }))).toMatchObject({ status: 409, code: 'balance_not_zero' });
    // The rule lives in the database, not just the repository.
    const raw = await sqlState(lockedWrite(g.groupId, bilal, (c, seq) =>
      c.query(`update memberships set status = 'left', left_at = now(), updated_seq = $2 where id = $1`, [b, seq])));
    expect(raw).toBe('ZB001');

    await createSettlement(app, { groupId: g.groupId, userId: bilal, settlement: { fromMemberId: b, toMemberId: g.ownerMember, amountMinor: 500 } });
    await leaveGroup(app, { groupId: g.groupId, userId: bilal });
    expect(await httpError(leaveGroup(app, { groupId: g.groupId, userId: bilal }))).toMatchObject({ status: 404 });
  });

  it('makes the owner transfer ownership first', async () => {
    const g = await groupWithOwner(app);
    expect(await httpError(leaveGroup(app, { groupId: g.groupId, userId: g.owner }))).toMatchObject({ status: 409, code: 'owner_must_transfer' });
  });
});

describe('invites', () => {
  it('cannot be reused', async () => {
    const g = await groupWithOwner(app);
    const { token } = await createInvite(app, { groupId: g.groupId, userId: g.owner });
    await acceptInvite(app, { token, userId: await user(app, 'Bilal') });
    expect(await httpError(acceptInvite(app, { token, userId: await user(app, 'Chirag') }))).toMatchObject({ status: 410, code: 'invite_invalid' });
  });

  it('cannot be used after expiry or once revoked by a newer invite for the same ghost', async () => {
    const g = await groupWithOwner(app);
    const expired = await createInvite(app, { groupId: g.groupId, userId: g.owner, ttlHours: 1 });
    await owner.query(`update invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`, [expired.inviteId]);
    expect((await httpError(acceptInvite(app, { token: expired.token, userId: await user(app, 'Bilal') }))).status).toBe(410);

    const ghost = await addGhost(app, { groupId: g.groupId, userId: g.owner, displayName: 'Dev' });
    const first = await createInvite(app, { groupId: g.groupId, userId: g.owner, ghostMemberId: ghost });
    await createInvite(app, { groupId: g.groupId, userId: g.owner, ghostMemberId: ghost });
    expect((await httpError(acceptInvite(app, { token: first.token, userId: await user(app, 'Dev') }))).status).toBe(410);
  });

  it('has exactly one winner when two people race for the same link', async () => {
    const g = await groupWithOwner(app);
    const { token } = await createInvite(app, { groupId: g.groupId, userId: g.owner });
    const results = await Promise.allSettled([
      acceptInvite(app, { token, userId: await user(app, 'Bilal') }),
      acceptInvite(app, { token, userId: await user(app, 'Chirag') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('is not consumed when the accept fails (already a member)', async () => {
    const g = await groupWithOwner(app);
    const { token } = await createInvite(app, { groupId: g.groupId, userId: g.owner });
    expect(await httpError(acceptInvite(app, { token, userId: g.owner }))).toMatchObject({ status: 409, code: 'already_member' });
    const { rows } = await app.query<{ used: boolean }>('select used_at is not null as used from invites where group_id = $1', [g.groupId]);
    expect(rows).toEqual([{ used: false }]);
  });
});

describe('concurrency', () => {
  it('concurrent duplicates of one idempotency key create exactly one expense', async () => {
    const { groupId, owner: actor, a, b } = await twoMembers();
    const key = randomUUID();
    const body = expense(1234, a, [a, b]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createExpense(app, { groupId, userId: actor, expense: body, idempotencyKey: key })),
    );
    expect(new Set(results.map((r) => r.expenseId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const { rows } = await app.query<{ n: number }>('select count(*)::int as n from expenses where group_id = $1', [groupId]);
    expect(rows[0]?.n).toBe(1);
  });

  it('two concurrent edits of the same version: one wins, the other gets 409', async () => {
    const { groupId, owner: actor, a, b } = await twoMembers();
    const { expenseId } = await createExpense(app, { groupId, userId: actor, expense: expense(1000, a, [a, b]) });
    const results = await Promise.allSettled([
      editExpense(app, { groupId, userId: actor, expenseId, expectedVersion: 1, expense: expense(2000, a, [a, b]) }),
      editExpense(app, { groupId, userId: actor, expenseId, expectedVersion: 1, expense: expense(3000, b, [a, b]) }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 409, code: 'version_conflict', details: { currentVersion: 2 } });
    const sums = await ledgerVsHeads(app, groupId);
    expect(sums.journal).toEqual(sums.heads);
  });
});
