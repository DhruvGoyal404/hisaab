import type { Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import type { Logger } from 'pino';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import { HttpError } from './errors.js';

/** `points` actions per `duration` seconds. */
export type Limit = { points: number; duration: number };

export type Limits = {
  /** Per client IP, across /api/auth/* and the dev sign-in. */
  auth: Limit;
  /** Per user. */
  expense: Limit;
  settlement: Limit;
  invite: Limit;
  /** Socket connections per user. */
  socket: Limit;
};

export const DEFAULT_LIMITS: Limits = {
  auth: { points: 30, duration: 10 * 60 },
  expense: { points: 60, duration: 10 * 60 },
  settlement: { points: 30, duration: 10 * 60 },
  invite: { points: 20, duration: 60 * 60 },
  socket: { points: 30, duration: 60 },
};

export type RateLimit = (key: string) => Promise<void>;
export type RateLimits = Record<keyof Limits, RateLimit>;

/**
 * One limiter per kind of action, all on the Postgres store (the rate_limits table, created by a
 * migration), so there is no new infrastructure and limits hold across API instances. A limiter
 * that can't reach its store lets the request through and logs it: failing open keeps the app
 * usable, and anything that can't reach Postgres can't do much else either. `namespace` prefixes
 * every key (tests use it to get counters of their own).
 */
export function createRateLimits(pool: pg.Pool, logger: Logger, limits: Limits = DEFAULT_LIMITS, namespace = ''): RateLimits {
  const make = (name: keyof Limits): RateLimit => {
    const limiter = new RateLimiterPostgres({
      storeClient: pool,
      storeType: 'pool',
      tableName: 'rate_limits',
      tableCreated: true,
      clearExpiredByTimeout: false,
      keyPrefix: `${namespace}${name}`,
      points: limits[name].points,
      duration: limits[name].duration,
    });
    return async (key: string) => {
      try {
        await limiter.consume(key);
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          const retryAfterSeconds = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
          throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${retryAfterSeconds} s.`, { retryAfterSeconds });
        }
        logger.error({ err, limiter: name }, 'rate limiter store failed; allowing the request');
      }
    };
  };
  return { auth: make('auth'), expense: make('expense'), settlement: make('settlement'), invite: make('invite'), socket: make('socket') };
}

/**
 * Express middleware: limit by a key derived from the request (429 with Retry-After when exceeded).
 * A key of undefined means the request isn't counted.
 */
export function limitBy(limit: RateLimit, key: (req: Request, res: Response) => string | undefined): RequestHandler {
  return async (req, res, next) => {
    const k = key(req, res);
    if (k !== undefined) await limit(k);
    next();
  };
}
