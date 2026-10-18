import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExpense } from '../../src/repo/expenses.js';
import { acceptInvite, addGhost, createGroup, createInvite, leaveGroup } from '../../src/repo/groups.js';
import { expense, ownerPool } from '../db/fixtures.js';
import { WEB_ORIGIN } from '../helpers.js';
import { quiet, recorder, startStack, until, type TestSocket } from './harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;
const owner = ownerPool();
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.close();
  await owner.end();
});

let n = 0;
const name = (base: string) => `${base}-${Date.now()}-${++n}`;

/** A group owned by a fresh user, with that user's session. */
async function ownedGroup() {
  const o = await stack.login(name('Owner'));
  const g = await createGroup(stack.pool, { userId: o.userId, name: 'G' });
  return { ...o, ...g };
}

const write = (g: { groupId: string; userId: string; memberId: string }, total = 100) =>
  createExpense(stack.pool, { groupId: g.groupId, userId: g.userId, expense: expense(total, g.memberId, [g.memberId]) });

function rejected(s: TestSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    s.once('connect_error', (err) => {
      resolve(err.message);
    });
    s.once('ready', () => {
      reject(new Error('socket was accepted'));
    });
  });
}

function disconnected(s: TestSocket): Promise<string> {
  return new Promise((resolve) => s.once('disconnect', (reason) => {
    resolve(reason);
  }));
}

describe('handshake', () => {
  it('rejects no cookie, a bad cookie, a wrong Origin and a missing Origin', async () => {
    const { cookie } = await stack.login(name('Asha'));
    expect(await rejected(stack.socket({}))).toBe('unauthenticated');
    expect(await rejected(stack.socket({ cookie: 'hisaab_session=forged' }))).toBe('unauthenticated');
    await rejected(stack.socket({ cookie, origin: 'https://evil.example' }));
    await rejected(stack.socket({ cookie, origin: null }));
    // Control: same cookie, allowed Origin.
    await stack.ready(stack.socket({ cookie }));
  });

  it('disconnects every socket of a session when it is revoked (logout)', async () => {
    const { cookie } = await stack.login(name('Asha'));
    const a = stack.socket({ cookie });
    const b = stack.socket({ cookie });
    await Promise.all([stack.ready(a), stack.ready(b)]);
    const gone = Promise.all([disconnected(a), disconnected(b)]);
    await request(stack.app).post('/api/dev/logout').set('Origin', WEB_ORIGIN).set('Cookie', cookie);
    expect(await gone).toEqual(['io server disconnect', 'io server disconnect']);
    expect(await rejected(stack.socket({ cookie }))).toBe('unauthenticated');
  });
});

describe('rooms', () => {
  it('a non-member never receives a group\'s signals', async () => {
    const g = await ownedGroup();
    const member = stack.socket({ cookie: g.cookie });
    const outsider = stack.socket({ cookie: (await stack.login(name('Mallory'))).cookie });
    await Promise.all([stack.ready(member), stack.ready(outsider)]);
    const mine = recorder(member);
    const theirs = recorder(outsider);
    await write(g);
    await until(() => mine.length === 1);
    await quiet(200);
    expect(theirs).toEqual([]);
  });

  it('joining adds the room, leaving removes it immediately', async () => {
    const g = await ownedGroup();
    const bilal = await stack.login(name('Bilal'));
    const s = stack.socket({ cookie: bilal.cookie });
    expect(await stack.ready(s)).toEqual([]);
    const got = recorder(s);

    const { token } = await createInvite(stack.pool, { groupId: g.groupId, userId: g.userId });
    await acceptInvite(stack.pool, { token, userId: bilal.userId }); // seq 3: member.joined
    await until(() => got.some((x) => x.seq === 3), 5_000, 'join signal');
    await write(g); // seq 4
    await until(() => got.some((x) => x.seq === 4), 5_000, 'post-join signal');

    await leaveGroup(stack.pool, { groupId: g.groupId, userId: bilal.userId }); // seq 5
    await stack.realtime.idle();
    await write(g); // seq 6
    await stack.realtime.idle();
    await quiet(200);
    expect(got.map((x) => x.seq).filter((seq) => seq >= 5)).toEqual([]);
  });

  it('claiming a ghost adds the room', async () => {
    const g = await ownedGroup();
    const ghost = await addGhost(stack.pool, { groupId: g.groupId, userId: g.userId, displayName: 'Dev' });
    const dev = await stack.login(name('Dev'));
    const s = stack.socket({ cookie: dev.cookie });
    await stack.ready(s);
    const got = recorder(s);
    const { token } = await createInvite(stack.pool, { groupId: g.groupId, userId: g.userId, ghostMemberId: ghost });
    await acceptInvite(stack.pool, { token, userId: dev.userId });
    await write(g);
    await until(() => got.length === 2, 5_000, 'claim + write signals'); // member.claimed, expense.created
  });

  it('a merge that reactivates a former member adds the room', async () => {
    const g = await ownedGroup();
    const dev = await stack.login(name('Dev'));
    const join = await createInvite(stack.pool, { groupId: g.groupId, userId: g.userId });
    await acceptInvite(stack.pool, { token: join.token, userId: dev.userId });
    await leaveGroup(stack.pool, { groupId: g.groupId, userId: dev.userId });
    const ghost = await addGhost(stack.pool, { groupId: g.groupId, userId: g.userId, displayName: 'Dev placeholder' });

    const s = stack.socket({ cookie: dev.cookie });
    expect(await stack.ready(s)).toEqual([]);
    const got = recorder(s);
    const { token } = await createInvite(stack.pool, { groupId: g.groupId, userId: g.userId, ghostMemberId: ghost });
    expect((await acceptInvite(stack.pool, { token, userId: dev.userId })).outcome).toBe('merged');
    await write(g);
    await until(() => got.length === 2, 5_000, 'merge + write signals');
  });
});

describe('delivery', () => {
  it('rolled-back writes emit nothing; committed writes emit exactly one signal each, in seq order', async () => {
    const g = await ownedGroup();
    const s = stack.socket({ cookie: g.cookie });
    await stack.ready(s);
    const got = recorder(s);

    const c = await stack.pool.connect();
    try {
      await c.query('begin');
      await c.query('update groups set last_seq = last_seq + 1 where id = $1', [g.groupId]);
      await c.query(`insert into activity_log (group_id, seq, actor_user_id, type) values ($1, 2, $2, 'test.write')`, [g.groupId, g.userId]);
      await c.query('rollback');
    } finally {
      c.release();
    }
    // Five writes racing each other; the group lock orders them.
    await Promise.all(Array.from({ length: 5 }, (_, i) => write(g, 100 + i)));
    await until(() => got.filter((s) => s.seq >= 2).length >= 5);
    await quiet(200);
    // seq 1 (group.created, committed before the socket joined) may arrive late and is ignorable.
    expect(got.filter((s) => s.seq >= 2)).toEqual([2, 3, 4, 5, 6].map((seq) => ({ groupId: g.groupId, seq })));
  });

  it('gap catch-up: a client that missed signals gets exactly the missing rows', async () => {
    const g = await ownedGroup();
    const first = stack.socket({ cookie: g.cookie });
    await stack.ready(first);
    const got = recorder(first);
    await write(g); // seq 2
    await until(() => got.length === 1);
    const lastSeen = got[0]?.seq ?? 0;
    first.disconnect();

    for (let i = 0; i < 3; i++) await write(g); // seq 3, 4, 5 while offline

    const again = stack.socket({ cookie: g.cookie });
    await stack.ready(again);
    const signals = recorder(again);
    again.emit('sync', { [g.groupId]: lastSeen });
    await until(() => signals.length === 1);
    expect(signals).toEqual([{ groupId: g.groupId, seq: 5 }]);

    const res = await request(stack.app).get(`/api/groups/${g.groupId}/activity?afterSeq=${lastSeen}`).set('Cookie', g.cookie);
    const body = res.body as { items: { seq: number }[]; lastSeq: number };
    expect(body.items.map((a) => a.seq)).toEqual([3, 4, 5]);
    expect(body.lastSeq).toBe(5);
  });

  it('listener connection killed: reconnects, emits resync, and delivery resumes', async () => {
    const g = await ownedGroup();
    const s = stack.socket({ cookie: g.cookie });
    await stack.ready(s);
    let resyncs = 0;
    s.on('resync', () => (resyncs += 1));
    const got = recorder(s);

    const pid = stack.listener.backendPid;
    await owner.query('select pg_terminate_backend($1)', [pid]);
    await until(() => resyncs === 1, 10_000, 'resync');
    expect(stack.listener.backendPid).not.toBe(pid);
    await write(g); // seq 2
    await until(() => got.some((x) => x.seq === 2), 5_000, 'signal after reconnect');
  });
});

describe('inbound policy', () => {
  it('any event other than sync disconnects', async () => {
    const { cookie } = await stack.login(name('Asha'));
    const s = stack.socket({ cookie });
    await stack.ready(s);
    const gone = disconnected(s);
    (s as unknown as { emit(e: string, p: unknown): void }).emit('expense:create', { totalMinor: 100 });
    expect(await gone).toBe('io server disconnect');
  });

  it('a malformed sync disconnects', async () => {
    const { cookie } = await stack.login(name('Asha'));
    const s = stack.socket({ cookie });
    await stack.ready(s);
    const gone = disconnected(s);
    (s as unknown as { emit(e: string, p: unknown): void }).emit('sync', { 'not-a-uuid': 'x' });
    expect(await gone).toBe('io server disconnect');
  });

  it('flooding sync past the rate limit disconnects', async () => {
    const { cookie } = await stack.login(name('Asha'));
    const s = stack.socket({ cookie });
    await stack.ready(s);
    const gone = disconnected(s);
    for (let i = 0; i < 30; i++) s.emit('sync', {});
    expect(await gone).toBe('io server disconnect');
  });
});

describe('load', () => {
  it('200 concurrent sockets: commit-to-signal latency and memory', { timeout: 180_000 }, async () => {
    const SOCKETS = 200;
    const USERS = 20;
    const WRITES = 10;
    const g = await ownedGroup();
    const users = [{ cookie: g.cookie, userId: g.userId }];
    for (let i = 1; i < USERS; i++) {
      const u = await stack.login(name('Load'));
      const { token } = await createInvite(stack.pool, { groupId: g.groupId, userId: g.userId });
      await acceptInvite(stack.pool, { token, userId: u.userId });
      users.push(u);
    }
    await stack.realtime.idle();

    globalThis.gc?.();
    const memBefore = process.memoryUsage();
    const sockets = Array.from({ length: SOCKETS }, (_, i) => stack.socket({ cookie: users[i % USERS]?.cookie ?? '' }));
    const startConnect = performance.now();
    await Promise.all(sockets.map((s) => stack.ready(s)));
    const connectMs = performance.now() - startConnect;
    globalThis.gc?.();
    const memAfter = process.memoryUsage();

    const received = new Map<number, number[]>(); // seq -> receive times
    for (const s of sockets) {
      s.on('group:changed', ({ groupId, seq }) => {
        if (groupId !== g.groupId) return;
        const list = received.get(seq) ?? [];
        list.push(performance.now());
        received.set(seq, list);
      });
    }

    const latencies: number[] = [];
    /** One raw write; returns its seq and the moment COMMIT was sent. */
    async function timedWrite(): Promise<{ seq: number; commitAt: number }> {
      const c = await stack.pool.connect();
      try {
        await c.query('begin');
        const { rows } = await c.query<{ last_seq: number }>('update groups set last_seq = last_seq + 1 where id = $1 returning last_seq', [g.groupId]);
        const seq = rows[0]?.last_seq ?? 0;
        await c.query(
          `insert into activity_log (group_id, seq, actor_user_id, type) values ($1, $2, $3, 'test.write')`,
          [g.groupId, seq, g.userId],
        );
        const commitAt = performance.now();
        await c.query('commit');
        return { seq, commitAt };
      } finally {
        c.release();
      }
    }

    for (let w = 0; w < WRITES; w++) {
      const { seq, commitAt } = await timedWrite();
      await until(() => (received.get(seq)?.length ?? 0) === SOCKETS, 20_000, `all sockets got seq ${seq}`);
      for (const t of received.get(seq) ?? []) latencies.push(t - commitAt);
    }

    latencies.sort((a, b) => a - b);
    const pct = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? NaN;
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
    const report = {
      sockets: SOCKETS,
      writes: WRITES,
      samples: latencies.length,
      connectAllMs: Math.round(connectMs),
      latencyMs: { p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +pct(1).toFixed(1) },
      // Server and clients share this process, so this includes the client side of every socket;
      // RSS, because heapUsed is unreliable without a forced GC (--expose-gc is not enabled).
      rssDeltaMB: mb(memAfter.rss - memBefore.rss),
      rssPerSocketKB: ((memAfter.rss - memBefore.rss) / SOCKETS / 1024).toFixed(1),
    };
    process.stdout.write(`\n[realtime load] ${JSON.stringify(report)}\n`);

    expect(latencies).toHaveLength(SOCKETS * WRITES);
    expect(pct(0.95)).toBeLessThan(1_000);
  });
});
