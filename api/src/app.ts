import express, { type Express } from 'express';
import type pg from 'pg';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { errorHandler, notFound } from './errors.js';
import { healthRouter } from './health.js';
import { requireAllowedOrigin } from './origin.js';

export type AppDeps = { config: Config; logger: Logger; pool: pg.Pool };

export function createApp({ config, logger, pool }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(pinoHttp({ logger }));
  app.use(requireAllowedOrigin(config.webOrigins));
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use(healthRouter(pool));
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
