import express, { type Express } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { devLoginRouter } from './devLogin.js';
import { errorHandler, notFound } from './errors.js';
import { createRateLimits, limitBy, type RateLimits } from './limits.js';
import { oauthRouter } from './oauth/router.js';
import { apiRoutes } from './routes.js';
import { healthRouter } from './health.js';
import { requireAllowedOrigin } from './origin.js';

export type AppDeps = { config: Config; logger: Logger; pool: pg.Pool; rateLimits?: RateLimits };

export function createApp({ config, logger, pool, rateLimits = createRateLimits(pool, logger) }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  // helmet's defaults (nosniff, frame and referrer policies, HSTS, COOP/CORP, ...). The API only
  // ever answers with JSON, so its own CSP can forbid everything; the page CSP comes with deploy.
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));

  app.use(pinoHttp({ logger }));
  app.use(requireAllowedOrigin(config.webOrigins));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(healthRouter(pool));
  // Per client IP on everything that starts, completes, links or ends a sign-in. The two read-only
  // listings are exempt: the sign-in and account pages fetch them on every visit.
  api.use(['/auth', '/dev/login'], limitBy(rateLimits.auth, (req) =>
    req.method === 'GET' && (req.path === '/providers' || req.path === '/identities') ? undefined : (req.ip ?? 'unknown'),
  ));
  api.use(oauthRouter(pool, config, logger));
  api.use(apiRoutes(pool, rateLimits));
  if (config.devLogin) {
    logger.warn('dev login enabled: anyone can sign in as any name');
    api.use(devLoginRouter(config.nodeEnv, pool));
  }
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
