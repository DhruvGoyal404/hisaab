import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../errors.js';
import { inTransaction, isUuid, logActivity, withGroupLock, withGroupWrite } from './tx.js';

const INVITE_TTL_HOURS = 7 * 24;
const MAX_INVITE_TTL_HOURS = 30 * 24;

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

export async function createGroup(
  pool: pg.Pool,
  input: { userId: string; name: string },
): Promise<{ groupId: string; memberId: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new HttpError(422, 'invalid_name', 'Group name must be 1-80 characters');
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      'insert into groups (name, created_by) values ($1, $2) returning id',
      [name, input.userId],
    );
    const groupId = rows[0]?.id;
    if (!groupId) throw new Error('insert returned no row');
    const { rows: seqRows } = await client.query<{ last_seq: number; currency: string }>(
      'update groups set last_seq = last_seq + 1 where id = $1 returning last_seq, currency',
      [groupId],
    );
    const { last_seq: seq, currency } = seqRows[0] ?? { last_seq: 0, currency: '' };
    const tx = { client, groupId, seq, currency };
    await logActivity(tx, input.userId, 'group.created', groupId, { name });
    const { rows: memberRows } = await client.query<{ id: string }>(
      `insert into memberships (group_id, user_id, role, created_seq, updated_seq) values ($1, $2, 'owner', $3, $3) returning id`,
      [groupId, input.userId, seq],
    );
    return { groupId, memberId: memberRows[0]?.id ?? '' };
  });
}

/** Adds a friend by name only; they can claim the place later through an invite. */
export async function addGhost(
  pool: pg.Pool,
  input: { groupId: string; userId: string; displayName: string },
): Promise<string> {
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 60) {
    throw new HttpError(422, 'invalid_name', 'Name must be 1-60 characters');
  }
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    const { rows } = await tx.client.query<{ id: string }>(
      `insert into memberships (group_id, display_name, created_seq, updated_seq) values ($1, $2, $3, $3) returning id`,
      [tx.groupId, displayName, tx.seq],
    );
    const memberId = rows[0]?.id ?? '';
    await logActivity(tx, input.userId, 'member.added', memberId, { displayName });
    return memberId;
  });
}

/**
 * Single-use invite link. With ghostMemberId it claims that ghost (any open invite for the same
 * ghost is revoked); without, it is a plain "join the group" link. Only the token's hash is stored.
 */
export async function createInvite(
  pool: pg.Pool,
  input: { groupId: string; userId: string; ghostMemberId?: string; ttlHours?: number },
): Promise<{ inviteId: string; token: string; expiresAt: Date }> {
  const ttlHours = input.ttlHours ?? INVITE_TTL_HOURS;
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_INVITE_TTL_HOURS) {
    throw new HttpError(422, 'invalid_ttl', 'Invites last between 1 hour and 30 days');
  }
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    const ghostId = input.ghostMemberId ?? null;
    if (ghostId !== null) {
      const { rowCount } = await tx.client.query(
        `select 1 from memberships where id = $1 and group_id = $2 and user_id is null and status = 'active'`,
        [isUuid(ghostId) ? ghostId : null, tx.groupId],
      );
      if (rowCount === 0) throw new HttpError(422, 'not_a_ghost', 'That member is not an unclaimed placeholder');
      await tx.client.query(
        'update invites set revoked_at = now() where ghost_member_id = $1 and used_at is null and revoked_at is null',
        [ghostId],
      );
    }
    const token = randomBytes(32).toString('base64url');
    const { rows } = await tx.client.query<{ id: string; expires_at: Date }>(
      `insert into invites (group_id, token_hash, ghost_member_id, created_by, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(hours => $5)) returning id, expires_at`,
      [tx.groupId, hashToken(token), ghostId, input.userId, ttlHours],
    );
    const invite = rows[0];
    if (!invite) throw new Error('insert returned no row');
    await logActivity(tx, input.userId, 'invite.created', invite.id, { ghostMemberId: ghostId });
    return { inviteId: invite.id, token, expiresAt: invite.expires_at };
  });
}

export type AcceptOutcome = 'joined' | 'rejoined' | 'claimed' | 'merged';

const inviteGone = () => new HttpError(410, 'invite_invalid', 'This invite link is invalid, already used, or expired');

/**
 * Consumes an invite atomically with the membership change (docs/SCHEMA.md §8). Any failure
 * rolls back, which also un-consumes the invite.
 */
export async function acceptInvite(
  pool: pg.Pool,
  input: { token: string; userId: string },
): Promise<{ groupId: string; memberId: string; outcome: AcceptOutcome }> {
  const tokenHash = hashToken(input.token);
  const { rows: found } = await pool.query<{ group_id: string }>('select group_id from invites where token_hash = $1', [tokenHash]);
  const groupId = found[0]?.group_id;
  if (!groupId) throw inviteGone();

  return withGroupLock(pool, groupId, async (tx) => {
    const { rows: used } = await tx.client.query<{ id: string; ghost_member_id: string | null }>(
      `update invites set used_at = now(), used_by = $2
        where token_hash = $1 and used_at is null and revoked_at is null and expires_at > now()
       returning id, ghost_member_id`,
      [tokenHash, input.userId],
    );
    const invite = used[0];
    if (!invite) throw inviteGone();

    const { rows: mine } = await tx.client.query<{ id: string; status: string }>(
      'select id, status from memberships where group_id = $1 and user_id = $2 for update',
      [groupId, input.userId],
    );
    const existing = mine[0];

    const reactivate = async (memberId: string) => {
      await tx.client.query(
        `update memberships set status = 'active', left_at = null, updated_seq = $2 where id = $1`,
        [memberId, tx.seq],
      );
    };

    if (invite.ghost_member_id === null) {
      if (existing?.status === 'active') throw new HttpError(409, 'already_member', 'You are already in this group');
      if (existing) {
        await reactivate(existing.id);
        await logActivity(tx, input.userId, 'member.rejoined', existing.id);
        return { groupId, memberId: existing.id, outcome: 'rejoined' };
      }
      const { rows } = await tx.client.query<{ id: string }>(
        'insert into memberships (group_id, user_id, created_seq, updated_seq) values ($1, $2, $3, $3) returning id',
        [groupId, input.userId, tx.seq],
      );
      const memberId = rows[0]?.id ?? '';
      await logActivity(tx, input.userId, 'member.joined', memberId);
      return { groupId, memberId, outcome: 'joined' };
    }

    const { rows: ghosts } = await tx.client.query<{ id: string; display_name: string }>(
      `select id, display_name from memberships where id = $1 and user_id is null and status = 'active' for update`,
      [invite.ghost_member_id],
    );
    const ghost = ghosts[0];
    if (!ghost) throw new HttpError(409, 'ghost_unavailable', 'That placeholder was already claimed or removed');

    if (!existing) {
      await tx.client.query(
        'update memberships set user_id = $2, display_name = null, updated_seq = $3 where id = $1',
        [ghost.id, input.userId, tx.seq],
      );
      await logActivity(tx, input.userId, 'member.claimed', ghost.id, { ghostName: ghost.display_name });
      return { groupId, memberId: ghost.id, outcome: 'claimed' };
    }

    // Already in the group (or was): keep the ghost row and link it to the real membership.
    if (existing.status !== 'active') await reactivate(existing.id);
    await tx.client.query(
      `update memberships set status = 'merged', merged_into = $2, updated_seq = $3 where id = $1`,
      [ghost.id, existing.id, tx.seq],
    );
    await logActivity(tx, input.userId, 'member.merged', existing.id, {
      ghostMemberId: ghost.id,
      ghostName: ghost.display_name,
    });
    return { groupId, memberId: existing.id, outcome: 'merged' };
  });
}

/** Leaving needs a zero balance (enforced by the database, surfaced as 409 balance_not_zero). */
export async function leaveGroup(pool: pg.Pool, input: { groupId: string; userId: string }): Promise<void> {
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    await tx.client.query(
      `update memberships set status = 'left', left_at = now(), updated_seq = $2 where id = $1`,
      [tx.member.id, tx.seq],
    );
    await logActivity(tx, input.userId, 'member.left', tx.member.id);
  });
}


/** Group setting: simplify debts (default on). When off, the settle plan defaults to the raw view. */
export async function setSimplifyDebts(
  pool: pg.Pool,
  input: { groupId: string; userId: string; simplifyDebts: boolean },
): Promise<void> {
  return withGroupWrite(pool, input.groupId, input.userId, async (tx) => {
    await tx.client.query('update groups set simplify_debts = $2 where id = $1', [tx.groupId, input.simplifyDebts]);
    await logActivity(tx, input.userId, 'group.settings_changed', tx.groupId, { simplifyDebts: input.simplifyDebts });
  });
}
