import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN } from './helpers.js';
import { startStack } from './realtime/harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

const cookieFrom = (res: request.Response) => /hisaab_session=[\w-]+/.exec(res.headers['set-cookie']?.toString() ?? '')?.[0] ?? '';
const me = (cookie: string) => request(stack.app).get('/api/me').set('Cookie', cookie);
const login = (name: string, cookie?: string) => {
  const r = request(stack.app).post('/api/dev/login').set('Origin', WEB_ORIGIN);
  return (cookie ? r.set('Cookie', cookie) : r).send({ name });
};

describe('session lifecycle', () => {
  it('signing in rotates the session: the token the browser came with is revoked', async () => {
    const first = cookieFrom(await login(`Asha-${Date.now()}`));
    expect((await me(first)).status).toBe(200);
    const second = cookieFrom(await login(`Asha-${Date.now()}`, first));
    expect(second).not.toBe(first);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });

  it('signing in as someone else also revokes the previous person’s session in this browser', async () => {
    const a = cookieFrom(await login(`A-${Date.now()}`));
    const b = cookieFrom(await login(`B-${Date.now()}`, a));
    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(200);
  });

  it('logout revokes this session and clears the cookie', async () => {
    const c = cookieFrom(await login(`Out-${Date.now()}`));
    const res = await request(stack.app).post('/api/auth/logout').set('Origin', WEB_ORIGIN).set('Cookie', c);
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']?.toString()).toMatch(/hisaab_session=;/);
    expect((await me(c)).status).toBe(401);
  });

  it('sign out everywhere revokes every session and disconnects their sockets', async () => {
    const name = `Everywhere-${Date.now()}`;
    const phone = cookieFrom(await login(name));
    const laptop = cookieFrom(await login(name));
    const other = cookieFrom(await login(`Bystander-${Date.now()}`));
    const sockets = [stack.socket({ cookie: phone }), stack.socket({ cookie: laptop })];
    const bystander = stack.socket({ cookie: other });
    await Promise.all([...sockets, bystander].map((s) => stack.ready(s)));
    const gone = Promise.all(sockets.map((s) => new Promise<string>((resolve) => s.once('disconnect', resolve))));

    const res = await request(stack.app).post('/api/auth/logout-all').set('Origin', WEB_ORIGIN).set('Cookie', phone);
    expect(res.body).toEqual({ revoked: 2 });
    expect(await gone).toEqual(['io server disconnect', 'io server disconnect']);
    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(401);
    expect((await me(other)).status).toBe(200);
    expect(bystander.connected).toBe(true);
  });
});
