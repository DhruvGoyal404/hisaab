import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../errors.js';
import { isUuid } from './tx.js';

export type IdempotencyScope = 'expense.create' | 'settlement.create';

/** Thrown inside the transaction to roll it back and hand the original resource to the caller. */
export class IdempotentReplay extends Error {
  constructor(readonly resourceId: string) {
    super('idempotent replay');
  }
}

/** JSON with object keys sorted at every level, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Claims (user, key) for this request inside the group-locked transaction. A committed request
 * with the same key and body makes this throw IdempotentReplay; a different body is a 422.
 * Concurrent duplicates queue on the group lock, so exactly one of them creates the resource.
 */
export async function claimIdempotencyKey(
  client: pg.ClientBase,
  userId: string,
  key: string,
  scope: IdempotencyScope,
  request: unknown,
  resourceId: string,
): Promise<void> {
  if (!isUuid(key)) throw new HttpError(422, 'invalid_idempotency_key', 'Idempotency-Key must be a UUID');
  const hash = createHash('sha256').update(canonicalJson(request)).digest();
  await client.query('delete from idempotency_keys where user_id = $1 and key = $2 and expires_at <= now()', [userId, key]);
  const inserted = await client.query(
    `insert into idempotency_keys (user_id, key, scope, request_hash, resource_id) values ($1, $2, $3, $4, $5)
     on conflict (user_id, key) do nothing`,
    [userId, key, scope, hash, resourceId],
  );
  if (inserted.rowCount === 1) return;

  const { rows } = await client.query<{ scope: string; request_hash: Buffer; resource_id: string }>(
    'select scope, request_hash, resource_id from idempotency_keys where user_id = $1 and key = $2',
    [userId, key],
  );
  const existing = rows[0];
  if (existing && existing.scope === scope && existing.request_hash.equals(hash)) {
    throw new IdempotentReplay(existing.resource_id);
  }
  throw new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
}
