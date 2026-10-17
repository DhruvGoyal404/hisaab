import { createHash } from 'node:crypto';
import { parseCookie } from 'cookie';
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { devLoginAllowed } from './config.js';
import { HttpError } from './errors.js';
import { createSession, findSession, revokeSession, SESSION_COOKIE } from './sessions.js';

const loginBody = z.object({ name: z.string().trim().min(1).max(60) });

const sessionToken = (req: Request): string | undefined => parseCookie(req.get('cookie') ?? '')[SESSION_COOKIE];

/** The same name always maps to the same dev user, keyed by a reserved .invalid email. */
async function findOrCreateDevUser(pool: pg.Pool, name: string): Promise<string> {
  const key = createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 16);
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, email) values ($1, $2)
     on conflict (email) where email is not null do update set display_name = excluded.display_name
     returning id`,
    [name, `dev+${key}@hisaab.invalid`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('upsert returned no row');
  return id;
}

/**
 * Sign in as any name, no password. Development and tests only: constructing the router
 * outside those environments throws, so a misconfigured server fails to start.
 */
export function devLoginRouter(nodeEnv: string, pool: pg.Pool): Router {
  if (!devLoginAllowed(nodeEnv)) {
    throw new Error(`dev login refused: NODE_ENV is "${nodeEnv}"`);
  }
  const router = Router();

  router.post('/dev/login', async (req, res) => {
    const { name } = loginBody.parse(req.body);
    const userId = await findOrCreateDevUser(pool, name);
    const { token, expiresAt } = await createSession(pool, userId, req.get('user-agent'));
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', expires: expiresAt });
    res.status(201).json({ user: { id: userId, name } });
  });

  router.get('/dev/me', async (req, res) => {
    const token = sessionToken(req);
    const session = token ? await findSession(pool, token) : undefined;
    if (!session) throw new HttpError(401, 'unauthenticated', 'Not signed in');
    res.json({ user: { id: session.userId, name: session.userName } });
  });

  router.post('/dev/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await revokeSession(pool, token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
