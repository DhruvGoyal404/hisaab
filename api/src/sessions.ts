import { createHash, randomBytes } from 'node:crypto';
import { parseCookie } from 'cookie';
import type { Request, Response } from 'express';
import type pg from 'pg';

export const SESSION_COOKIE = 'hisaab_session';
export const SESSION_TTL_DAYS = 7;

/** 256-bit opaque token handed to the client. Only its SHA-256 is stored (no salt needed at this entropy). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export type Session = { sessionId: string; userId: string; userName: string; expiresAt: Date };

export async function createSession(
  pool: pg.Pool,
  userId: string,
  userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const { rows } = await pool.query<{ expires_at: Date }>(
    `insert into sessions (user_id, token_hash, expires_at, user_agent)
     values ($1, $2, now() + make_interval(days => $3), $4) returning expires_at`,
    [userId, hashSessionToken(token), SESSION_TTL_DAYS, userAgent?.slice(0, 200) ?? null],
  );
  const expiresAt = rows[0]?.expires_at;
  if (!expiresAt) throw new Error('insert returned no row');
  return { token, expiresAt };
}

/** The live session for a token: not revoked, not expired, user not disabled. */
export async function findSession(pool: pg.Pool, token: string): Promise<Session | undefined> {
  const { rows } = await pool.query<Session>(
    `select s.id as "sessionId", s.user_id as "userId", u.display_name as "userName", s.expires_at as "expiresAt"
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.disabled_at is null`,
    [hashSessionToken(token)],
  );
  return rows[0];
}

export async function revokeSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hashSessionToken(token)]);
}

export const sessionToken = (req: Request): string | undefined => parseCookie(req.get('cookie') ?? '')[SESSION_COOKIE];

/**
 * Revokes every live session of a user ("sign out everywhere"). Each revoked row fires the
 * hisaab_session notification, so the sockets of all those sessions are disconnected.
 */
export async function revokeAllSessions(pool: pg.Pool, userId: string): Promise<number> {
  const { rowCount } = await pool.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
  return rowCount ?? 0;
}

/**
 * Issues a session for `userId` and sets its cookie (Secure in production). Rotation: any session
 * the browser came with is revoked first, so a token planted before sign-in (session fixation)
 * or left from another account never survives a sign-in.
 */
export async function startSession(pool: pg.Pool, req: Request, res: Response, userId: string, secure: boolean): Promise<void> {
  const previous = sessionToken(req);
  if (previous) await revokeSession(pool, previous);
  const { token, expiresAt } = await createSession(pool, userId, req.get('user-agent'));
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}
