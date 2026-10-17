import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool } from '../src/db.js';

export const WEB_ORIGIN = 'http://localhost:5174';

/** Nothing listens on port 1, so connections fail fast. */
export const UNREACHABLE_DB = 'postgres://hisaab:x@127.0.0.1:1/hisaab?sslmode=disable';

export const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: UNREACHABLE_DB,
  WEB_ORIGINS: WEB_ORIGIN,
  LOG_LEVEL: 'silent',
};

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...baseEnv, ...overrides });
}

export function buildApp(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const logger = pino({ level: 'silent' });
  const pool = createPool(config.databaseUrl, logger);
  return { app: createApp({ config, logger, pool }), pool, config };
}
