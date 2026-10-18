import type pg from 'pg';
import { inTransaction, logActivity, notFound } from './tx.js';

export const DELETED_NAME = 'Deleted user';

/**
 * Deletes an account without touching the ledger. In one transaction:
 * - the users row is anonymised and marked deleted (rows elsewhere still point at it);
 * - in every group, the membership becomes a placeholder named "Deleted user" (numbered if the
 *   name is taken), so its balance stays exactly where it was and the group still adds up; an
 *   owner's role passes to an admin, else the longest-standing member; one activity row per group;
 * - sessions are revoked (which disconnects their sockets) and then removed, along with sign-in
 *   identities, unfinished sign-in flows and idempotency keys.
 * Groups are locked in id order, the same order any other multi-group writer would use.
 */
export async function deleteAccount(pool: pg.Pool, userId: string): Promise<{ groups: number }> {
  return inTransaction(pool, async (client) => {
    const deleted = await client.query(
      `update users set display_name = $2, email = null, avatar_url = null,
                        disabled_at = coalesce(disabled_at, now()), deleted_at = now()
        where id = $1 and deleted_at is null`,
      [userId, DELETED_NAME],
    );
    if (deleted.rowCount !== 1) throw notFound();

    const { rows: groups } = await client.query<{ group_id: string }>(
      'select distinct group_id from memberships where user_id = $1 order by group_id',
      [userId],
    );
    for (const { group_id: groupId } of groups) {
      const { rows: [locked] } = await client.query<{ last_seq: number; currency: string }>(
        'update groups set last_seq = last_seq + 1 where id = $1 returning last_seq, currency',
        [groupId],
      );
      if (!locked) throw new Error(`group ${groupId} vanished`);
      const tx = { client, groupId, seq: locked.last_seq, currency: locked.currency };

      const { rows: [member] } = await client.query<{ id: string; role: string; status: string }>(
        'select id, role, status from memberships where group_id = $1 and user_id = $2',
        [groupId, userId],
      );
      if (!member) throw new Error(`membership in ${groupId} vanished`);

      const { rows: taken } = await client.query<{ name: string }>(
        `select lower(display_name) as name from memberships where group_id = $1 and user_id is null and status = 'active'`,
        [groupId],
      );
      const names = new Set(taken.map((t) => t.name));
      let displayName = DELETED_NAME;
      for (let n = 2; names.has(displayName.toLowerCase()); n++) displayName = `${DELETED_NAME} ${n}`;

      let newOwnerMemberId: string | null = null;
      if (member.role === 'owner' && member.status === 'active') {
        const { rows: [next] } = await client.query<{ id: string }>(
          `select id from memberships
            where group_id = $1 and user_id is not null and user_id <> $2 and status = 'active'
            order by role = 'admin' desc, created_seq, id limit 1`,
          [groupId, userId],
        );
        newOwnerMemberId = next?.id ?? null;
      }

      await client.query(
        `update memberships set user_id = null, display_name = $2, role = 'member', updated_seq = $3 where id = $1`,
        [member.id, displayName, tx.seq],
      );
      if (newOwnerMemberId) {
        await client.query(`update memberships set role = 'owner', updated_seq = $2 where id = $1`, [newOwnerMemberId, tx.seq]);
      }
      await logActivity(tx, userId, 'member.deleted_account', member.id, { displayName, newOwnerMemberId });
    }

    await client.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
    await client.query('delete from sessions where user_id = $1', [userId]);
    await client.query('delete from oauth_identities where user_id = $1', [userId]);
    await client.query('delete from oauth_flows where user_id = $1', [userId]);
    await client.query('delete from idempotency_keys where user_id = $1', [userId]);
    return { groups: groups.length };
  });
}
