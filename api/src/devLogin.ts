import { parseCookie } from 'cookie';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { devLoginAllowed } from './config.js';
import { HttpError } from './errors.js';
import {
  hashSessionToken,
  newSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Session,
  type SessionStore,
} from './sessions.js';

const loginBody = z.object({ name: z.string().trim().min(1).max(50) });

async function currentSession(req: Request, store: SessionStore): Promise<{ hash: string; session: Session } | undefined> {
  const token = parseCookie(req.get('cookie') ?? '')[SESSION_COOKIE];
  if (!token) return undefined;
  const hash = hashSessionToken(token);
  const session = await store.get(hash);
  return session ? { hash, session } : undefined;
}

/**
 * Sign in as any name, no password. Development and tests only: constructing the router
 * outside those environments throws, so a misconfigured server fails to start.
 */
export function devLoginRouter(nodeEnv: string, store: SessionStore): Router {
  if (!devLoginAllowed(nodeEnv)) {
    throw new Error(`dev login refused: NODE_ENV is "${nodeEnv}"`);
  }
  const router = Router();

  router.post('/dev/login', async (req, res) => {
    const { name } = loginBody.parse(req.body);
    const token = newSessionToken();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await store.create(hashSessionToken(token), { userName: name, expiresAt });
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(expiresAt) });
    res.status(201).json({ user: { name } });
  });

  router.get('/dev/me', async (req, res) => {
    const current = await currentSession(req, store);
    if (!current) throw new HttpError(401, 'unauthenticated', 'Not signed in');
    res.json({ user: { name: current.session.userName } });
  });

  router.post('/dev/logout', async (req, res) => {
    const current = await currentSession(req, store);
    if (current) await store.delete(current.hash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
