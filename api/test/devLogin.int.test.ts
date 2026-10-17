import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { hashSessionToken } from '../src/sessions.js';
import { ownerPool } from './db/fixtures.js';
import { buildApp, WEB_ORIGIN } from './helpers.js';

const { app, pool } = buildApp({ DEV_LOGIN: 'true', DATABASE_URL: inject('appDatabaseUrl') });
const owner = ownerPool();
afterAll(() => Promise.all([pool.end(), owner.end()]));

const tokenFrom = (setCookie: unknown): string => /hisaab_session=([\w-]+);/.exec(String(setCookie))?.[1] ?? '';

describe('dev login with Postgres sessions', () => {
  it('logs in, stores only the token hash, identifies the session, and logs out', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'Asha' });
    expect(login.status).toBe(201);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/hisaab_session=[\w-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);

    const token = tokenFrom(setCookie);
    const userId = (login.body as { user: { id: string } }).user.id;
    const { rows } = await pool.query<{ token_hash: Buffer; revoked: boolean }>(
      'select token_hash, revoked_at is not null as revoked from sessions where user_id = $1', [userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash.equals(hashSessionToken(token))).toBe(true);
    expect(rows[0]?.token_hash.toString('utf8')).not.toContain(token);

    const me = await agent.get('/api/dev/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ user: { id: userId, name: 'Asha' } });

    expect((await agent.post('/api/dev/logout').set('Origin', WEB_ORIGIN)).status).toBe(204);
    expect((await request(app).get('/api/dev/me').set('Cookie', `hisaab_session=${token}`)).status).toBe(401);
    const after = await pool.query<{ revoked: boolean }>('select revoked_at is not null as revoked from sessions where user_id = $1', [userId]);
    expect(after.rows).toEqual([{ revoked: true }]);
  });

  it('maps the same name to the same user', async () => {
    const first = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'Bilal' });
    const second = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'bilal' });
    expect((second.body as { user: { id: string } }).user.id).toBe((first.body as { user: { id: string } }).user.id);
  });

  it('rejects unknown and expired sessions', async () => {
    expect((await request(app).get('/api/dev/me').set('Cookie', 'hisaab_session=forged')).status).toBe(401);

    const login = await request(app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'Chirag' });
    const token = tokenFrom(login.headers['set-cookie']);
    await owner.query(
      `update sessions set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where token_hash = $1`,
      [hashSessionToken(token)],
    );
    expect((await request(app).get('/api/dev/me').set('Cookie', `hisaab_session=${token}`)).status).toBe(401);
  });
});
