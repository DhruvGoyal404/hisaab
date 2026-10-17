import request from 'supertest';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from './helpers.js';

const { app, pool } = buildApp({ DATABASE_URL: inject('appDatabaseUrl') });
afterAll(() => pool.end());

describe('GET /api/health against Postgres', () => {
  it('reports ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('runs on Postgres 18 with citext installed, connected as a non-owner role', async () => {
    const { rows } = await pool.query<{ version: number; citext: boolean; superuser: boolean }>(
      `select current_setting('server_version_num')::int / 10000 as version,
              exists (select 1 from pg_extension where extname = 'citext') as citext,
              (select rolsuper from pg_roles where rolname = current_user) as superuser`,
    );
    expect(rows[0]).toEqual({ version: 18, citext: true, superuser: false });
  });
});
