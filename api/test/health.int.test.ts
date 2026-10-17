import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('integration tests need DATABASE_URL (see api/.env.example)');

const { app, pool } = buildApp({ DATABASE_URL: databaseUrl });
afterAll(() => pool.end());

describe('GET /api/health against Postgres', () => {
  it('reports ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('runs on Postgres 18 with the baseline migration applied', async () => {
    const { rows } = await pool.query<{ version: number; citext: boolean }>(
      `select current_setting('server_version_num')::int / 10000 as version,
              exists (select 1 from pg_extension where extname = 'citext') as citext`,
    );
    expect(rows[0]).toEqual({ version: 18, citext: true });
  });
});
