import { parseCookie } from 'cookie';
import type { RequestHandler, Response } from 'express';
import type pg from 'pg';
import { HttpError } from './errors.js';
import { findSession, SESSION_COOKIE, type Session } from './sessions.js';

/** 401 unless the request carries a live session cookie; the session is kept in res.locals. */
export function requireSession(pool: pg.Pool): RequestHandler {
  return async (req, res, next) => {
    const token = parseCookie(req.get('cookie') ?? '')[SESSION_COOKIE];
    const session = token ? await findSession(pool, token) : undefined;
    if (!session) throw new HttpError(401, 'unauthenticated', 'Not signed in');
    res.locals.session = session;
    next();
  };
}

export function sessionOf(res: Response): Session {
  const session = res.locals.session as Session | undefined;
  if (!session) throw new Error('requireSession must run before this handler');
  return session;
}
