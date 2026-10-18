import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Limits } from '../src/limits.js';
import { GENEROUS_LIMITS, WEB_ORIGIN } from './helpers.js';
import { startStack } from './realtime/harness.js';

// Small limits under a namespace of their own, so the counters start at zero and no other suite
// (all signing in from 127.0.0.1 against the same database) shares them.
const LIMITS: Limits = {
  ...GENEROUS_LIMITS,
  auth: { points: 4, duration: 600 },
  expense: { points: 2, duration: 600 },
  settlement: { points: 1, duration: 600 },
  invite: { points: 1, duration: 3600 },
  socket: { points: 2, duration: 60 },
};

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  stack = await startStack(undefined, { values: LIMITS, namespace: `t${randomUUID().slice(0, 8)}:` });
});
afterAll(() => stack.close());

const post = (cookie: string, url: string) => request(stack.app).post(url).set('Origin', WEB_ORIGIN).set('Cookie', cookie);

function expectLimited(res: request.Response) {
  expect(res.status).toBe(429);
  expect((res.body as { error: { code: string } }).error.code).toBe('rate_limited');
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(3600);
}

describe('rate limits', () => {
  // The auth limit is spent first and deliberately: every later sign-in in this file would count too.
  let asha: { cookie: string; userId: string };
  let bilal: { cookie: string; userId: string };

  it('limits sign-in attempts per IP across /auth/* and the dev sign-in, with Retry-After', async () => {
    asha = await stack.login(`Asha-${Date.now()}`);
    bilal = await stack.login(`Bilal-${Date.now()}`);
    expect((await request(stack.app).get('/api/auth/google/start')).status).not.toBe(429);
    expect((await request(stack.app).post('/api/auth/logout').set('Origin', WEB_ORIGIN)).status).toBe(204);

    expectLimited(await request(stack.app).post('/api/dev/login').set('Origin', WEB_ORIGIN).send({ name: 'Chirag' }));
    expectLimited(await request(stack.app).get('/api/auth/github/start'));
    // The read-only listings the sign-in and account pages load are not counted.
    expect((await request(stack.app).get('/api/auth/providers')).status).toBe(200);
    // Nor are ordinary API calls from people already signed in.
    expect((await request(stack.app).get('/api/me').set('Cookie', asha.cookie)).status).toBe(200);
  });

  it('limits expense, settlement and invite creation per user', async () => {
    const group = (await post(asha.cookie, '/api/groups').send({ name: 'Trip' })).body as { groupId: string; memberId: string };
    const invite = await post(asha.cookie, `/api/groups/${group.groupId}/invites`).send({});
    expect(invite.status).toBe(201);
    const accepted = await post(bilal.cookie, `/api/invites/${(invite.body as { token: string }).token}/accept`).expect(200);
    const bilalMember = (accepted.body as { memberId: string }).memberId;
    expectLimited(await post(asha.cookie, `/api/groups/${group.groupId}/invites`).send({}));

    const expense = {
      description: 'Dinner', occurredOn: '2026-10-19', totalMinor: 1000,
      payers: [{ memberId: group.memberId, paidMinor: 1000 }],
      split: { method: 'equal', weights: [{ memberId: group.memberId, weight: 1 }, { memberId: bilalMember, weight: 1 }] },
    };
    expect((await post(asha.cookie, `/api/groups/${group.groupId}/expenses`).send(expense)).status).toBe(201);
    expect((await post(asha.cookie, `/api/groups/${group.groupId}/expenses`).send(expense)).status).toBe(201);
    expectLimited(await post(asha.cookie, `/api/groups/${group.groupId}/expenses`).send(expense));
    // Per user, not per group or per IP: Bilal still can.
    expect((await post(bilal.cookie, `/api/groups/${group.groupId}/expenses`).send(expense)).status).toBe(201);

    const settlement = { fromMemberId: bilalMember, toMemberId: group.memberId, amountMinor: 100 };
    expect((await post(bilal.cookie, `/api/groups/${group.groupId}/settlements`).send(settlement)).status).toBe(201);
    expectLimited(await post(bilal.cookie, `/api/groups/${group.groupId}/settlements`).send(settlement));
  });

  it('limits socket connections per user; the refusal carries retryAfterSeconds', async () => {
    const first = stack.socket({ cookie: asha.cookie });
    const second = stack.socket({ cookie: asha.cookie });
    await Promise.all([stack.ready(first), stack.ready(second)]);

    const third = stack.socket({ cookie: asha.cookie });
    const err = (await stack.ready(third).then(() => undefined, (e: unknown) => e)) as (Error & { data?: { retryAfterSeconds?: number } }) | undefined;
    expect(err?.message).toBe('rate_limited');
    expect(err?.data?.retryAfterSeconds).toBeGreaterThan(0);

    // Another user's connections are counted separately.
    await stack.ready(stack.socket({ cookie: bilal.cookie }));
  });
});
