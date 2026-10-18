import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import '../../src/db.js'; // registers the int8 parser
import type { SplitMethod } from '@hisaab/money';
import { HttpError } from '../../src/errors.js';
import type { ExpenseInput } from '../../src/repo/expenses.js';
import { createGroup } from '../../src/repo/groups.js';
import { createUser } from '../../src/repo/users.js';

/** Pool connected as the privilege-limited app role (what the API uses). */
export const appPool = (): pg.Pool => new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 8 });
/** Pool connected as the owner role, for asserting the triggers hold even with full privileges. */
export const ownerPool = (): pg.Pool => new pg.Pool({ connectionString: inject('ownerDatabaseUrl'), max: 2 });

export const user = (pool: pg.Pool, name: string): Promise<string> =>
  createUser(pool, { displayName: name, email: `${name.toLowerCase()}-${randomUUID()}@test.invalid` });

export async function groupWithOwner(pool: pg.Pool, ownerName = 'Asha') {
  const owner = await user(pool, ownerName);
  const { groupId, memberId } = await createGroup(pool, { userId: owner, name: `${ownerName}'s group` });
  return { owner, groupId, ownerMember: memberId };
}

export function expense(
  totalMinor: number,
  payer: string,
  participants: string[],
  method: SplitMethod = 'equal',
  weights?: number[],
): ExpenseInput {
  return {
    description: 'Test expense',
    occurredOn: '2026-10-18',
    totalMinor,
    payers: [{ memberId: payer, paidMinor: totalMinor }],
    split: { method, weights: participants.map((memberId, i) => ({ memberId, weight: weights?.[i] ?? 1 })) },
  };
}

/** Resolves to the HttpError a promise rejects with (fails the test if it resolves). */
export async function httpError(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected the promise to reject');
}

/** Resolves to the Postgres error code (SQLSTATE) a promise rejects with. */
export async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw err;
  }
  throw new Error('expected the query to fail');
}

export const balanceOf = (balances: { memberId: string; balanceMinor: number }[], memberId: string): number | undefined =>
  balances.find((b) => b.memberId === memberId)?.balanceMinor;

/**
 * Recomputes every member's balance from the current (head) expense versions and unvoided
 * settlements, independently of the journal, and returns both views keyed by member.
 */
export async function ledgerVsHeads(pool: pg.Pool, groupId: string): Promise<{ journal: Record<string, number>; heads: Record<string, number> }> {
  const toMap = (rows: { member_id: string; amount: number }[]) =>
    Object.fromEntries(rows.filter((r) => r.amount !== 0).map((r) => [r.member_id, r.amount]));
  const { rows: journal } = await pool.query<{ member_id: string; amount: number }>(
    'select member_id, sum(delta_minor)::bigint as amount from ledger_entries where group_id = $1 group by member_id',
    [groupId],
  );
  const { rows: heads } = await pool.query<{ member_id: string; amount: number }>(
    `select member_id, sum(d)::bigint as amount from (
       select l.member_id, l.paid_minor - l.owed_minor as d
         from expenses e
         join expense_versions v on v.expense_id = e.id and v.version = e.head_version
         join expense_lines l on l.expense_id = v.expense_id and l.version = v.version
        where e.group_id = $1
       union all
       select s.from_member_id, s.amount_minor from settlements s
        where s.group_id = $1 and not exists (select 1 from settlement_voids x where x.settlement_id = s.id)
       union all
       select s.to_member_id, -s.amount_minor from settlements s
        where s.group_id = $1 and not exists (select 1 from settlement_voids x where x.settlement_id = s.id)
     ) t group by member_id`,
    [groupId],
  );
  return { journal: toMap(journal), heads: toMap(heads) };
}

export async function journalTotal(pool: pg.Pool, groupId: string): Promise<number> {
  const { rows } = await pool.query<{ total: number }>(
    'select coalesce(sum(delta_minor), 0)::bigint as total from ledger_entries where group_id = $1',
    [groupId],
  );
  return rows[0]?.total ?? NaN;
}
