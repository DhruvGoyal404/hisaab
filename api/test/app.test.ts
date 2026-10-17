import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, WEB_ORIGIN } from './helpers.js';

const { app, pool } = buildApp();
afterAll(() => pool.end());

describe('error handling', () => {
  it('returns 400 for a malformed JSON body', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"amount": 12,,, garbage');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_body', message: 'Malformed JSON body' } });
  });

  it('returns 413 for an oversized body', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('does not advertise Express', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('origin check', () => {
  it('rejects a non-GET request without an Origin header', async () => {
    const res = await request(app).post('/api/health').send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'bad_origin' } });
  });

  it('rejects a non-GET request from a foreign origin', async () => {
    const res = await request(app).delete('/api/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('lets GET through without an Origin header', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/health', () => {
  it('reports 503 when Postgres is unreachable', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: 'unreachable' });
  });
});
