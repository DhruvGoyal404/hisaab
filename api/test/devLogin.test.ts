import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { devLoginRouter } from '../src/devLogin.js';
import { hashSessionToken, MemorySessionStore } from '../src/sessions.js';
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

  it('the router itself refuses to be built in production', () => {
    expect(() => devLoginRouter('production', new MemorySessionStore())).toThrow(/dev login refused/);
  });

  it('the server process exits non-zero when DEV_LOGIN=true and NODE_ENV=production', async () => {
    const { code, stderr } = await runToExit({ ...baseEnv, NODE_ENV: 'production', DEV_LOGIN: 'true' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/DEV_LOGIN: dev login may only be enabled/);
  }, 20_000);
});

describe('dev login routes', () => {
  const dev = buildApp({ DEV_LOGIN: 'true' });
  const prod = buildApp({ NODE_ENV: 'production' });
  afterAll(() => Promise.all([dev.pool.end(), prod.pool.end()]));

  it('logs in, keeps only a hash of the token, and identifies the session', async () => {
    const agent = request.agent(dev.app);
    const login = await agent.post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'Asha' });
    expect(login.status).toBe(201);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/hisaab_session=[\w-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);

    const token = /hisaab_session=([\w-]+);/.exec(setCookie)?.[1] ?? '';
    expect(dev.sessions.hashes).toEqual([hashSessionToken(token)]);
    expect(dev.sessions.hashes).not.toContain(token);

    const me = await agent.get('/api/dev/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: { name: 'Asha' } });

    const logout = await agent.post('/api/dev/logout').set('Origin', WEB_ORIGIN);
    expect(logout.status).toBe(204);
    expect((await agent.get('/api/dev/me')).status).toBe(401);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await request(dev.app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('rejects an unknown session cookie', async () => {
    const res = await request(dev.app).get('/api/dev/me').set('Cookie', 'hisaab_session=forged');
    expect(res.status).toBe(401);
  });

  it('is not mounted when DEV_LOGIN is off', async () => {
    const res = await request(prod.app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});
