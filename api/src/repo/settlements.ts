import type pg from 'pg';
import { MAX_TOTAL_MINOR } from '@hisaab/money';
import { HttpError } from '../errors.js';
import { claimIdempotencyKey, IdempotentReplay } from './idempotency.js';
import { isUuid, logActivity, withGroupWrite } from './tx.js';

export type SettlementInput = { fromMemberId: string; toMemberId: string; amountMinor: number; note?: string };

/** Records a payment from one member to another; the database posts it to the journal. */
export async function createSettlement(
  pool: pg.Pool,
  input: { groupId: string; userId: string; settlement: SettlementInput; idempotencyKey?: string },
): Promise<{ settlementId: string; replayed: boolean }> {
  const { fromMemberId, toMemberId, amountMinor, note } = input.settlement;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > MAX_TOTAL_MINOR) {
    throw new HttpError(422, 'invalid_amount', 'Amount must be between 1 paisa and ₹100 crore');
  }
  if (fromMemberId === toMemberId) throw new HttpError(422, 'invalid_settlement', 'A member cannot pay themselves');
  if (note !== undefined && note.length > 200) throw new HttpError(422, 'invalid_note', 'Note must be at most 200 characters');

  try {
    return await withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
      const { rows } = await tx.client.query<{ id: string }>('select uuidv7() as id');
      const settlementId = rows[0]?.id ?? '';
      if (input.idempotencyKey !== undefined) {
        await claimIdempotencyKey(tx.client, input.userId, input.idempotencyKey, 'settlement.create',
          { groupId: input.groupId, settlement: input.settlement }, settlementId);
      }
      const ids = [fromMemberId, toMemberId];
      const { rowCount } = await tx.client.query(
        `select 1 from memberships m cross join lateral effective_member(m.id) e
          where m.group_id = $1 and m.id = any($2::uuid[]) and e.status = 'active'`,
        [tx.groupId, ids.every(isUuid) ? ids : []],
      );
      if (rowCount !== 2) throw new HttpError(422, 'unknown_member', 'Both people must be current members of the group');

      await logActivity(tx, input.userId, 'settlement.created', settlementId, { fromMemberId, toMemberId, amountMinor });
      await tx.client.query(
        `insert into settlements (id, group_id, currency, from_member_id, to_member_id, amount_minor, note, author_user_id, seq)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [settlementId, tx.groupId, tx.currency, fromMemberId, toMemberId, amountMinor, note ?? null, input.userId, tx.seq],
      );
      return { settlementId, replayed: false };
    });
  } catch (err) {
    if (err instanceof IdempotentReplay) return { settlementId: err.resourceId, replayed: true };
    throw err;
  }
}
