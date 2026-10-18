// Reads that issue several queries must see one snapshot. Here a write commits on another
// connection between two queries of the same read; the read must not see it.
import { afterAll, describe, expect, it } from 'vitest';
import { createExpense } from '../src/repo/expenses.js';
import { addGhost } from '../src/repo/groups.js';
import { selectActivityPage, selectGroupBalances } from '../src/repo/reads.js';
import { inTransaction, withGroupRead } from '../src/repo/tx.js';
import { appPool, expense, groupWithOwner, sqlState } from './db/fixtures.js';

const pool = appPool();
afterAll(() => pool.end());

async function setup() {
  const g = await groupWithOwner(pool, 'Asha');
  const bilal = await addGhost(pool, { groupId: g.groupId, userId: g.owner, displayName: 'Bilal' });
  await createExpense(pool, { groupId: g.groupId, userId: g.owner, expense: expense(1000, g.ownerMember, [g.ownerMember, bilal]) });
  return { ...g, bilal };
}

/** Balances, then a concurrent write commits, then the feed and the journal, all on one client. */
async function interleaved(client: import('pg').PoolClient, g: Awaited<ReturnType<typeof setup>>) {
  const balances = await selectGroupBalances(client, g.groupId);
  await createExpense(pool, { groupId: g.groupId, userId: g.owner, expense: expense(400, g.bilal, [g.ownerMember, g.bilal]) });
  const feed = await selectActivityPage(client, g.groupId, undefined, 50);
  const { rows } = await client.query<{ member_id: string; total: number }>(
    'select member_id, sum(delta_minor)::bigint as total from ledger_entries where group_id = $1 group by member_id',
    [g.groupId],
  );
  const journal = Object.fromEntries(rows.map((r) => [r.member_id, r.total]));
  return { balances, feed, journal };
}

describe('read snapshots', () => {
  it('REPEATABLE READ: a write committed between two queries is invisible to the read', async () => {
    const g = await setup();
    const r = await withGroupRead(pool, g.groupId, g.owner, (client) => interleaved(client, g));

    // Balances, feed and journal all describe the state before the concurrent expense.
    expect(r.balances.map((b) => b.balanceMinor)).toEqual([500, -500]);
    expect(r.feed.items.map((a) => a.type)).toEqual(['expense.created', 'member.added', 'group.created']);
    expect(r.journal).toEqual({ [g.ownerMember]: 500, [g.bilal]: -500 });

    // The write did commit; a fresh read sees it.
    const after = await withGroupRead(pool, g.groupId, g.owner, (client) => selectGroupBalances(client, g.groupId));
    expect(after.map((b) => b.balanceMinor)).toEqual([300, -300]);
  });

  it('control: the same interleaving under READ COMMITTED would mix two states', async () => {
    const g = await setup();
    const r = await inTransaction(pool, (client) => interleaved(client, g), 'write');
    expect(r.balances.map((b) => b.balanceMinor)).toEqual([500, -500]);
    expect(r.feed.items).toHaveLength(4); // sees the concurrent expense.created
    expect(r.journal).toEqual({ [g.ownerMember]: 300, [g.bilal]: -300 });
  });

  it('read transactions are READ ONLY', async () => {
    const g = await setup();
    const state = await sqlState(withGroupRead(pool, g.groupId, g.owner, (client) =>
      client.query(`insert into users (display_name) values ('nope')`)));
    expect(state).toBe('25006'); // read_only_sql_transaction
  });
});
