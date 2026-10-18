import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { devLoginRouter } from '../src/devLogin.js';
import { baseEnv, buildApp, WEB_ORIGIN } from './helpers.js';
import { runToExit } from './spawn.js';

describe('dev login guard', () => {
  it('config rejects DEV_LOGIN=true in production', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', DEV_LOGIN: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', DEV_LOGIN: 'true' })).toThrow(/DEV_LOGIN/);
  });

  it('config allows DEV_LOGIN=true in development and test', () => {
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'development', DEV_LOGIN: 'true' }).devLogin).toBe(true);
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'test', DEV_LOGIN: 'true' }).devLogin).toBe(true);
  });

  it('there is no other environment to enable it in: NODE_ENV must be development, test or production', () => {
    for (const NODE_ENV of ['staging', 'prod', '', undefined]) {
      expect(() => loadConfig({ ...baseEnv, NODE_ENV, DEV_LOGIN: 'true' })).toThrow(ConfigError);
    }
  });

  it('the router itself refuses to be built in production', () => {
    const { pool } = buildApp();
    expect(() => devLoginRouter('production', pool)).toThrow(/dev login refused/);
    return pool.end();
  });

  it('the server process exits non-zero when DEV_LOGIN=true and NODE_ENV=production', async () => {
    const { code, stderr } = await runToExit({ ...baseEnv, NODE_ENV: 'production', DEV_LOGIN: 'true' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/DEV_LOGIN: dev login may only be enabled/);
  }, 20_000);
});

describe('dev login routes without a database', () => {
  const dev = buildApp({ DEV_LOGIN: 'true' });
  const prod = buildApp({ NODE_ENV: 'production' });
  afterAll(() => Promise.all([dev.pool.end(), prod.pool.end()]));

  it('rejects an invalid body with 400 before touching the database', async () => {
    const res = await request(dev.app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('is not mounted when DEV_LOGIN is off', async () => {
    const res = await request(prod.app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});
