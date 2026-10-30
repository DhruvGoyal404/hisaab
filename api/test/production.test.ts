import { pino } from 'pino';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createRateLimits } from '../src/limits.js';
import { GENEROUS_LIMITS } from './helpers.js';
import { runToExit, startServer } from './spawn.js';

// Nothing development-only can be switched on in production: the config refuses it, the dev
// routes are not registered, and the real process exits before it listens.
const ORIGIN = 'https://hisaab.example';
const DB_PASSWORD = 'pr0d-s3cret-pw';
const DB_URL = `postgres://hisaab:${DB_PASSWORD}@127.0.0.1:1/hisaab?sslmode=disable`;
const PROD = { NODE_ENV: 'production', DATABASE_URL: DB_URL, WEB_ORIGINS: ORIGIN, PUBLIC_URL: ORIGIN };

describe('production config', () => {
  it('accepts the production shape, with no dev sign-in and no trusted proxy unless told', () => {
    expect(loadConfig(PROD)).toMatchObject({ nodeEnv: 'production', devLogin: false, trustProxy: 0, publicUrl: ORIGIN });
    expect(loadConfig({ ...PROD, TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });

  it('refuses every development switch by name', () => {
    const keys = ['DEV_LOGIN', 'GOOGLE_ISSUER', 'GOOGLE_AUTH_URL', 'GOOGLE_TOKEN_URL', 'GOOGLE_JWKS_URL', 'GITHUB_AUTH_URL', 'GITHUB_TOKEN_URL', 'GITHUB_API_URL'];
    for (const key of keys) {
      const value = key === 'DEV_LOGIN' ? 'true' : 'http://127.0.0.1:1/mock';
      expect(() => loadConfig({ ...PROD, [key]: value }), key).toThrow(new RegExp(key));
    }
  });

  it('needs an https PUBLIC_URL and https WEB_ORIGINS (OAuth redirects and the Origin check are built on them)', () => {
    expect(() => loadConfig({ ...PROD, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL: required in production/);
    expect(() => loadConfig({ ...PROD, PUBLIC_URL: 'http://hisaab.example' })).toThrow(/PUBLIC_URL: must be https/);
    expect(() => loadConfig({ ...PROD, WEB_ORIGINS: `${ORIGIN},http://localhost:5174` })).toThrow(/WEB_ORIGINS: must all be https/);
  });

  it('never echoes the database URL in a refusal', () => {
    let message = '';
    try {
      loadConfig({ ...PROD, DEV_LOGIN: 'true' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DEV_LOGIN/);
    expect(message).not.toContain(DB_PASSWORD);
  });
});

describe('the production route table', () => {
  const config = loadConfig(PROD);
  const logger = pino({ level: 'silent' });
  const pool = createPool(config.databaseUrl, logger);
  const app = createApp({ config, logger, pool, rateLimits: createRateLimits(pool, logger, GENEROUS_LIMITS) });
  afterAll(() => pool.end());

  it('has no dev sign-in, even with an allowed Origin', async () => {
    const res = await request(app).post('/api/dev/login').set('Origin', ORIGIN).send({ name: 'intruder' });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('tells the sign-in page there is no dev sign-in', async () => {
    expect((await request(app).get('/api/auth/providers')).body).toMatchObject({ dev: false });
  });
});

describe('trust proxy', () => {
  // Behind the edge, req.ip must be the client (from X-Forwarded-For), or every visitor would share
  // one per-IP sign-in limit. Without TRUST_PROXY a client-sent X-Forwarded-For must be ignored.
  const logger = pino({ level: 'silent' });
  const seen: string[] = [];
  function appWith(trustProxy: string) {
    const config = loadConfig({ ...PROD, TRUST_PROXY: trustProxy });
    const pool = createPool(config.databaseUrl, logger);
    const limit = (key: string) => { seen.push(key); return Promise.resolve(); };
    const rateLimits = { ...createRateLimits(pool, logger, GENEROUS_LIMITS), auth: limit };
    return { app: createApp({ config, logger, pool, rateLimits }), pool };
  }
  const one = appWith('1');
  const none = appWith('0');
  afterAll(() => Promise.all([one.pool.end(), none.pool.end()]));

  it('limits sign-ins by the client address the edge forwards, and only when told to trust it', async () => {
    seen.length = 0;
    await request(one.app).post('/api/auth/logout').set('Origin', ORIGIN).set('X-Forwarded-For', '203.0.113.7');
    await request(none.app).post('/api/auth/logout').set('Origin', ORIGIN).set('X-Forwarded-For', '203.0.113.7');
    expect(seen[0]).toBe('203.0.113.7');
    expect(seen[1]).not.toBe('203.0.113.7');
  });
});

describe('the real API process', () => {
  it('refuses to start with NODE_ENV=production and DEV_LOGIN=true, naming the key, never the database URL', async () => {
    const { code, stderr } = await runToExit({ ...PROD, DEV_LOGIN: 'true' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/DEV_LOGIN/);
    expect(stderr).not.toContain(DB_PASSWORD);
  }, 20_000);

  it('refuses to start with an http PUBLIC_URL', async () => {
    const { code, stderr } = await runToExit({ ...PROD, PUBLIC_URL: 'http://hisaab.example' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/PUBLIC_URL/);
  }, 20_000);

  it('starts in production without dev sign-in, and never logs the database URL', async () => {
    const { child, output } = await startServer({ ...PROD, TRUST_PROXY: '1' });
    child.kill();
    expect(output()).not.toMatch(/dev login enabled/);
    expect(output()).not.toContain(DB_PASSWORD);
  }, 20_000);
});
