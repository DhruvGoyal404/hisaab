import type pg from 'pg';
import { HttpError } from '../errors.js';
import { inTransaction, withGroupRead } from './tx.js';

// Every read runs as one REPEATABLE READ, READ ONLY transaction (withGroupRead / inTransaction
// 'read'), so all its queries see the same snapshot even if a write commits in between. Reads do
// not take the group write lock: the snapshot is already consistent, and the lock would stall writers.
// The select* functions take a client so callers can combine several of them in one snapshot.

export type MemberBalance = { memberId: string; name: string; isGhost: boolean; balanceMinor: number };

/** Net balance per active member, in paise; positive = the group owes them. Merged ghosts fold into their member. */
export async function selectGroupBalances(client: pg.ClientBase, groupId: string): Promise<MemberBalance[]> {
  const { rows } = await client.query<MemberBalance>(
      `with posted as (
         select coalesce(m.merged_into, m.id) as member_id, le.delta_minor
           from memberships m
           join ledger_entries le on le.member_id = m.id
          where m.group_id = $1
       )
       select m.id as "memberId",
              coalesce(u.display_name, m.display_name) as name,
              m.user_id is null as "isGhost",
              coalesce(sum(p.delta_minor), 0)::bigint as "balanceMinor"
         from memberships m
         left join users u  on u.id = m.user_id
         left join posted p on p.member_id = m.id
        where m.group_id = $1 and m.status = 'active'
        group by m.id, u.display_name, m.display_name, m.user_id
        order by "balanceMinor" desc, m.id`,
      [groupId],
    );
  return rows;
}

export function groupBalances(pool: pg.Pool, input: { groupId: string; userId: string }): Promise<MemberBalance[]> {
  return withGroupRead(pool, input.groupId, input.userId, (client) => selectGroupBalances(client, input.groupId));
}

export type UserGroupBalance = { groupId: string; name: string; currency: string; balanceMinor: number };
export type CurrencyTotal = { currency: string; owedToMeMinor: number; iOweMinor: number; netMinor: number };

/** The caller's balance in every active group, plus per-currency totals. */
export function userBalances(pool: pg.Pool, input: { userId: string }): Promise<{ groups: UserGroupBalance[]; totals: CurrencyTotal[] }> {
  return inTransaction(
    pool,
    async (client) => {
      const { rows: groups } = await client.query<UserGroupBalance>(
        `select g.id as "groupId", g.name, g.currency,
                coalesce(sum(le.delta_minor), 0)::bigint as "balanceMinor"
           from memberships me
           join groups g on g.id = me.group_id
          cross join lateral (
                select me.id as member_id
                union all
                select x.id from memberships x where x.merged_into = me.id
          ) src
           left join ledger_entries le on le.member_id = src.member_id
          where me.user_id = $1 and me.status = 'active' and g.archived_at is null
          group by g.id, g.name, g.currency
          order by g.name, g.id`,
        [input.userId],
      );
      const totals = new Map<string, CurrencyTotal>();
      for (const g of groups) {
        const t = totals.get(g.currency) ?? { currency: g.currency, owedToMeMinor: 0, iOweMinor: 0, netMinor: 0 };
        if (g.balanceMinor > 0) t.owedToMeMinor += g.balanceMinor;
        else t.iOweMinor -= g.balanceMinor;
        t.netMinor += g.balanceMinor;
        totals.set(g.currency, t);
      }
      return { groups, totals: [...totals.values()] };
    },
    'read',
  );
}

export type ActivityItem = {
  seq: number;
  id: string;
  type: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  actorName: string | null;
};

export const MAX_FEED_PAGE = 50;

/** Newest first, keyset-paginated by seq: pass the previous page's `nextBefore` as `before`. */
export function activityFeed(
  pool: pg.Pool,
  input: { groupId: string; userId: string; before?: number; limit?: number },
): Promise<{ items: ActivityItem[]; nextBefore: number | null }> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FEED_PAGE) {
    return Promise.reject(new HttpError(422, 'invalid_limit', `limit must be 1-${MAX_FEED_PAGE}`));
  }
  if (input.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 1)) {
    return Promise.reject(new HttpError(422, 'invalid_cursor', 'before must be a positive integer'));
  }
  return withGroupRead(pool, input.groupId, input.userId, (client) =>
    selectActivityPage(client, input.groupId, input.before, limit));
}

export async function selectActivityPage(
  client: pg.ClientBase,
  groupId: string,
  before: number | undefined,
  limit: number,
): Promise<{ items: ActivityItem[]; nextBefore: number | null }> {
  const { rows } = await client.query<ActivityItem>(
    `select a.seq, a.id, a.type, a.subject_id as "subjectId", a.payload, a.created_at as "createdAt",
            u.display_name as "actorName"
       from activity_log a
       left join users u on u.id = a.actor_user_id
      where a.group_id = $1 and a.seq < coalesce($2::bigint, 9223372036854775807)
      order by a.seq desc
      limit $3`,
    [groupId, before ?? null, limit + 1],
  );
  const items = rows.slice(0, limit);
  return { items, nextBefore: rows.length > limit ? (items.at(-1)?.seq ?? null) : null };
}
