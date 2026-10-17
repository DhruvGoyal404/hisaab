import type pg from 'pg';
import { allocate, AllocationError, MAX_TOTAL_MINOR, type SplitMethod, type WeightInput } from '../domain/allocate.js';
import { HttpError } from '../errors.js';
import { claimIdempotencyKey, IdempotentReplay } from './idempotency.js';
import { isUuid, logActivity, notFound, withGroupRead, withGroupWrite, type GroupTx } from './tx.js';

export type ExpenseInput = {
  description: string;
  /** Calendar date, YYYY-MM-DD. */
  occurredOn: string;
  totalMinor: number;
  payers: { memberId: string; paidMinor: number }[];
  split: { method: SplitMethod; weights: WeightInput[] };
};

export type ExpenseLine = { memberId: string; paidMinor: number; owedMinor: number; weight: number | null };

export type ExpenseView = {
  expenseId: string;
  version: number;
  deleted: boolean;
  description: string;
  occurredOn: string;
  totalMinor: number;
  splitMethod: SplitMethod;
  lines: ExpenseLine[];
};

const invalid = (code: string, message: string) => new HttpError(422, code, message);

/** Validates the input and resolves it to integer-paise lines through allocate(). */
export function buildLines(expenseId: string, input: ExpenseInput): ExpenseLine[] {
  const description = input.description.trim();
  if (description.length < 1 || description.length > 200) throw invalid('invalid_description', 'Description must be 1-200 characters');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn) || Number.isNaN(Date.parse(input.occurredOn))) {
    throw invalid('invalid_date', 'occurredOn must be a YYYY-MM-DD date');
  }
  const { totalMinor } = input;
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 1 || totalMinor > MAX_TOTAL_MINOR) {
    throw invalid('invalid_total', 'Total must be between 1 paisa and ₹100 crore');
  }

  const lines = new Map<string, ExpenseLine>();
  const line = (memberId: string): ExpenseLine => {
    let l = lines.get(memberId);
    if (!l) lines.set(memberId, (l = { memberId, paidMinor: 0, owedMinor: 0, weight: null }));
    return l;
  };

  let paid = 0;
  for (const p of input.payers) {
    if (!Number.isSafeInteger(p.paidMinor) || p.paidMinor < 1) throw invalid('invalid_payer', 'Each payer must pay at least 1 paisa');
    if (lines.get(p.memberId)?.paidMinor) throw invalid('invalid_payer', 'A member is listed as payer twice');
    line(p.memberId).paidMinor = p.paidMinor;
    paid += p.paidMinor;
  }
  if (input.payers.length === 0 || paid !== totalMinor) {
    throw invalid('payers_mismatch', `Payers cover ${paid} paise but the total is ${totalMinor}`);
  }

  let shares;
  try {
    shares = allocate(totalMinor, input.split.method, input.split.weights, expenseId);
  } catch (err) {
    if (err instanceof AllocationError) throw invalid('invalid_split', err.message);
    throw err;
  }
  for (const s of shares) {
    const l = line(s.memberId);
    l.owedMinor = s.owedMinor;
    l.weight = s.weight;
  }
  for (const id of lines.keys()) if (!isUuid(id)) throw invalid('unknown_member', 'Unknown member');
  return [...lines.values()];
}

/** Every line's member must belong to the group and be active (a merged ghost counts via its target). */
async function assertMembersUsable(tx: GroupTx, lines: ExpenseLine[]): Promise<void> {
  const ids = lines.map((l) => l.memberId);
  const { rowCount } = await tx.client.query(
    `select 1 from memberships m cross join lateral effective_member(m.id) e
      where m.group_id = $1 and m.id = any($2::uuid[]) and e.status = 'active'`,
    [tx.groupId, ids],
  );
  if (rowCount !== ids.length) throw invalid('unknown_member', 'Every participant must be a current member of the group');
}

async function insertVersion(
  tx: GroupTx,
  authorUserId: string,
  expenseId: string,
  version: number,
  kind: 'create' | 'edit' | 'delete',
  input: ExpenseInput | null,
  lines: ExpenseLine[],
): Promise<void> {
  await tx.client.query(
    `insert into expense_versions
       (expense_id, version, group_id, currency, kind, description, total_minor, split_method, occurred_on, author_user_id, seq)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      expenseId, version, tx.groupId, tx.currency, kind,
      input?.description.trim() ?? null, input?.totalMinor ?? null, input?.split.method ?? null, input?.occurredOn ?? null,
      authorUserId, tx.seq,
    ],
  );
  if (lines.length === 0) return;
  await tx.client.query(
    `insert into expense_lines (expense_id, version, group_id, member_id, paid_minor, owed_minor, weight)
     select $1, $2, $3, t.m, t.p, t.o, t.w
       from unnest($4::uuid[], $5::bigint[], $6::bigint[], $7::bigint[]) as t(m, p, o, w)`,
    [
      expenseId, version, tx.groupId,
      lines.map((l) => l.memberId), lines.map((l) => l.paidMinor), lines.map((l) => l.owedMinor), lines.map((l) => l.weight),
    ],
  );
}

type VersionRow = {
  version: number;
  kind: 'create' | 'edit' | 'delete';
  description: string | null;
  occurred_on: string | null;
  total_minor: number | null;
  split_method: SplitMethod | null;
};

const VERSION_COLUMNS = `v.version, v.kind, v.description, to_char(v.occurred_on, 'YYYY-MM-DD') as occurred_on,
  v.total_minor, v.split_method`;

/** The head version, or the latest version that is not a delete. */
async function versionRow(client: pg.ClientBase, expenseId: string, which: 'head' | 'last-live'): Promise<VersionRow | undefined> {
  const { rows } = await client.query<VersionRow>(
    which === 'head'
      ? `select ${VERSION_COLUMNS} from expenses e
           join expense_versions v on v.expense_id = e.id and v.version = e.head_version
          where e.id = $1`
      : `select ${VERSION_COLUMNS} from expense_versions v
          where v.expense_id = $1 and v.kind <> 'delete' order by v.version desc limit 1`,
    [expenseId],
  );
  return rows[0];
}

async function linesOf(client: pg.ClientBase, expenseId: string, version: number): Promise<ExpenseLine[]> {
  const { rows } = await client.query<ExpenseLine>(
    `select member_id as "memberId", paid_minor as "paidMinor", owed_minor as "owedMinor", weight
       from expense_lines where expense_id = $1 and version = $2 order by member_id`,
    [expenseId, version],
  );
  return rows;
}

/** Current state. A deleted expense shows the content it deleted, flagged `deleted`. */
async function readHead(client: pg.ClientBase, expenseId: string): Promise<ExpenseView | undefined> {
  const h = await versionRow(client, expenseId, 'head');
  if (!h) return undefined;
  const content = h.kind === 'delete' ? await versionRow(client, expenseId, 'last-live') : h;
  if (!content) return undefined;
  return {
    expenseId,
    version: h.version,
    deleted: h.kind === 'delete',
    description: content.description ?? '',
    occurredOn: content.occurred_on ?? '',
    totalMinor: content.total_minor ?? 0,
    splitMethod: content.split_method ?? 'equal',
    lines: await linesOf(client, expenseId, content.version),
  };
}

async function lockedHead(tx: GroupTx, expenseId: string, expectedVersion: number): Promise<VersionRow> {
  if (!isUuid(expenseId)) throw notFound();
  const { rowCount } = await tx.client.query('select 1 from expenses where id = $1 and group_id = $2', [expenseId, tx.groupId]);
  if (rowCount === 0) throw notFound();
  const h = await versionRow(tx.client, expenseId, 'head');
  if (!h) throw notFound();
  if (h.version !== expectedVersion) {
    throw new HttpError(409, 'version_conflict', 'The expense was changed by someone else', { currentVersion: h.version });
  }
  return h;
}

export async function createExpense(
  pool: pg.Pool,
  input: { groupId: string; userId: string; expense: ExpenseInput; idempotencyKey?: string },
): Promise<{ expenseId: string; version: number; replayed: boolean }> {
  try {
    return await withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
      const { rows } = await tx.client.query<{ id: string }>('select uuidv7() as id');
      const expenseId = rows[0]?.id ?? '';
      if (input.idempotencyKey !== undefined) {
        await claimIdempotencyKey(tx.client, input.userId, input.idempotencyKey, 'expense.create',
          { groupId: input.groupId, expense: input.expense }, expenseId);
      }
      const lines = buildLines(expenseId, input.expense);
      await assertMembersUsable(tx, lines);
      await logActivity(tx, input.userId, 'expense.created', expenseId, {
        version: 1, description: input.expense.description.trim(), totalMinor: input.expense.totalMinor,
      });
      await tx.client.query('insert into expenses (id, group_id, created_seq) values ($1, $2, $3)', [expenseId, tx.groupId, tx.seq]);
      await insertVersion(tx, input.userId, expenseId, 1, 'create', input.expense, lines);
      return { expenseId, version: 1, replayed: false };
    });
  } catch (err) {
    if (!(err instanceof IdempotentReplay)) throw err;
    const { rows } = await pool.query<{ head_version: number }>('select head_version from expenses where id = $1', [err.resourceId]);
    return { expenseId: err.resourceId, version: rows[0]?.head_version ?? 1, replayed: true };
  }
}

/** Optimistic concurrency: `expectedVersion` must be the current head, else 409 with the current version. */
export async function editExpense(
  pool: pg.Pool,
  input: { groupId: string; userId: string; expenseId: string; expectedVersion: number; expense: ExpenseInput },
): Promise<{ version: number }> {
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    const h = await lockedHead(tx, input.expenseId, input.expectedVersion);
    if (h.kind === 'delete') throw new HttpError(409, 'expense_deleted', 'Restore the expense before editing it');
    const lines = buildLines(input.expenseId, input.expense);
    await assertMembersUsable(tx, lines);
    const version = h.version + 1;
    await logActivity(tx, input.userId, 'expense.edited', input.expenseId, { fromVersion: h.version, toVersion: version });
    await insertVersion(tx, input.userId, input.expenseId, version, 'edit', input.expense, lines);
    return { version };
  });
}

/** Delete = a new version with no lines; the database posts the reversal. */
export async function deleteExpense(
  pool: pg.Pool,
  input: { groupId: string; userId: string; expenseId: string; expectedVersion: number },
): Promise<{ version: number }> {
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    const h = await lockedHead(tx, input.expenseId, input.expectedVersion);
    if (h.kind === 'delete') throw new HttpError(409, 'already_deleted', 'The expense is already deleted');
    const version = h.version + 1;
    await logActivity(tx, input.userId, 'expense.deleted', input.expenseId, { fromVersion: h.version, toVersion: version });
    await insertVersion(tx, input.userId, input.expenseId, version, 'delete', null, []);
    return { version };
  });
}

/** Restore = a new 'edit' version carrying the content of the last version before the delete. */
export async function restoreExpense(
  pool: pg.Pool,
  input: { groupId: string; userId: string; expenseId: string; expectedVersion: number },
): Promise<{ version: number }> {
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    const h = await lockedHead(tx, input.expenseId, input.expectedVersion);
    if (h.kind !== 'delete') throw new HttpError(409, 'not_deleted', 'Only a deleted expense can be restored');
    const live = await versionRow(tx.client, input.expenseId, 'last-live');
    if (!live) throw new Error(`expense ${input.expenseId} has no version to restore`);
    const previous = await linesOf(tx.client, input.expenseId, live.version);
    const expense: ExpenseInput = {
      description: live.description ?? '',
      occurredOn: live.occurred_on ?? '',
      totalMinor: live.total_minor ?? 0,
      payers: previous.filter((l) => l.paidMinor > 0).map((l) => ({ memberId: l.memberId, paidMinor: l.paidMinor })),
      split: {
        method: live.split_method ?? 'equal',
        weights: previous.flatMap((l) => (l.weight === null ? [] : [{ memberId: l.memberId, weight: l.weight }])),
      },
    };
    // Same weights and the same seed (the expense id) reproduce the same shares.
    const lines = buildLines(input.expenseId, expense);
    await assertMembersUsable(tx, lines);
    const version = h.version + 1;
    await logActivity(tx, input.userId, 'expense.restored', input.expenseId, {
      fromVersion: h.version, toVersion: version, restoredFromVersion: live.version,
    });
    await insertVersion(tx, input.userId, input.expenseId, version, 'edit', expense, lines);
    return { version };
  });
}

export function getExpense(
  pool: pg.Pool,
  input: { groupId: string; userId: string; expenseId: string },
): Promise<ExpenseView> {
  return withGroupRead(pool, input.groupId, input.userId, async (client) => {
    if (!isUuid(input.expenseId)) throw notFound();
    const { rowCount } = await client.query('select 1 from expenses where id = $1 and group_id = $2', [input.expenseId, input.groupId]);
    if (rowCount === 0) throw notFound();
    const view = await readHead(client, input.expenseId);
    if (!view) throw notFound();
    return view;
  });
}
