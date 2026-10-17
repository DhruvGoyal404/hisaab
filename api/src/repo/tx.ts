import type pg from 'pg';
import { HttpError } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

export const notFound = (what = 'Not found'): HttpError => new HttpError(404, 'not_found', what);

// Custom SQLSTATEs raised by the schema's triggers (docs/SCHEMA.md §12). Anything not listed here
// (ZA*, ZS*, ZL001, ZG*, ZM004) is a programming error and stays a 500.
const DB_ERRORS: Record<string, [status: number, code: string, message: string]> = {
  ZV001: [409, 'version_conflict', 'The expense was changed by someone else'],
  ZV002: [409, 'already_deleted', 'The expense is already deleted'],
  ZB001: [409, 'balance_not_zero', 'Settle up before leaving the group'],
  ZM001: [409, 'member_not_active', 'A member involved is no longer in the group'],
  ZM002: [409, 'owner_must_transfer', 'Transfer ownership before leaving'],
  ZM003: [409, 'invalid_merge', 'That member cannot be merged'],
  ZL002: [422, 'invalid_split', 'The split does not add up to the total'],
};
const CONSTRAINT_ERRORS: Record<string, [status: number, code: string, message: string]> = {
  memberships_ghost_name_key: [409, 'ghost_name_taken', 'Someone in the group already has that name'],
};

function translateDbError(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  const mapped =
    (typeof constraint === 'string' ? CONSTRAINT_ERRORS[constraint] : undefined) ??
    (typeof code === 'string' ? DB_ERRORS[code] : undefined);
  return mapped ? new HttpError(...mapped) : err;
}

/**
 * One transaction. 'write' is READ COMMITTED (group writes serialize on the group row lock);
 * 'read' is a REPEATABLE READ snapshot so a membership check and the query agree.
 * Deferred constraint checks run at COMMIT, so their errors surface here too.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  mode: 'write' | 'read' = 'write',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(mode === 'read' ? 'begin isolation level repeatable read read only' : 'begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw translateDbError(err);
  } finally {
    client.release();
  }
}

export type GroupTx = { client: pg.PoolClient; groupId: string; seq: number; currency: string };
export type Member = { id: string; role: 'owner' | 'admin' | 'member' };

/**
 * Takes the group's write lock and allocates this transaction's sequence number. Every
 * ledger-affecting write must run inside this; the schema rejects writes that don't.
 */
export function withGroupLock<T>(pool: pg.Pool, groupId: string, fn: (tx: GroupTx) => Promise<T>): Promise<T> {
  if (!isUuid(groupId)) return Promise.reject(notFound());
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ last_seq: number; currency: string }>(
      'update groups set last_seq = last_seq + 1 where id = $1 and archived_at is null returning last_seq, currency',
      [groupId],
    );
    const row = rows[0];
    if (!row) throw notFound();
    return fn({ client, groupId, seq: row.last_seq, currency: row.currency });
  });
}

export async function activeMembership(client: pg.ClientBase, groupId: string, userId: string): Promise<Member | undefined> {
  const { rows } = await client.query<Member>(
    `select id, role from memberships where group_id = $1 and user_id = $2 and status = 'active'`,
    [groupId, userId],
  );
  return rows[0];
}

/** Group lock plus "the caller is an active member" (otherwise 404, same as a missing group). */
export function withGroupWrite<T>(
  pool: pg.Pool,
  groupId: string,
  userId: string,
  fn: (tx: GroupTx & { member: Member }) => Promise<T>,
): Promise<T> {
  return withGroupLock(pool, groupId, async (tx) => {
    const member = await activeMembership(tx.client, groupId, userId);
    if (!member) throw notFound();
    return fn({ ...tx, member });
  });
}

/** Read-only snapshot for an active member of the group (otherwise 404). */
export function withGroupRead<T>(
  pool: pg.Pool,
  groupId: string,
  userId: string,
  fn: (client: pg.PoolClient, member: Member) => Promise<T>,
): Promise<T> {
  if (!isUuid(groupId)) return Promise.reject(notFound());
  return inTransaction(
    pool,
    async (client) => {
      const member = await activeMembership(client, groupId, userId);
      if (!member) throw notFound();
      return fn(client, member);
    },
    'read',
  );
}

/** The transaction's one activity row; its (group_id, seq) is what every other write points at. */
export async function logActivity(
  tx: GroupTx,
  actorUserId: string | null,
  type: string,
  subjectId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.client.query(
    `insert into activity_log (group_id, seq, actor_user_id, type, subject_id, payload) values ($1, $2, $3, $4, $5, $6)`,
    [tx.groupId, tx.seq, actorUserId, type, subjectId, payload],
  );
}
