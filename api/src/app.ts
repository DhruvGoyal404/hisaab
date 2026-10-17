import express, { type Express } from 'express';
import type pg from 'pg';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { devLoginRouter } from './devLogin.js';
import { errorHandler, notFound } from './errors.js';
import { healthRouter } from './health.js';
import { requireAllowedOrigin } from './origin.js';
import { MemorySessionStore, type SessionStore } from './sessions.js';

export type AppDeps = { config: Config; logger: Logger; pool: pg.Pool; sessions?: SessionStore };

export function createApp({ config, logger, pool, sessions = new MemorySessionStore() }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger }));
  app.use(requireAllowedOrigin(config.webOrigins));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(healthRouter(pool));
  if (config.devLogin) {
    logger.warn('dev login enabled: anyone can sign in as any name');
    api.use(devLoginRouter(config.nodeEnv, sessions));
  }
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
