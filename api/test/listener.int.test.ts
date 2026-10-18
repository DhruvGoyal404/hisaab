import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgListener, type GroupSignal } from '../src/realtime/listener.js';
import { createExpense } from '../src/repo/expenses.js';
import { createSession, revokeSession } from '../src/sessions.js';
import { appPool, expense, groupWithOwner, ownerPool, user } from './db/fixtures.js';

const pool = appPool();
const owner = ownerPool();
const listener = new PgListener(inject('appDatabaseUrl'), pino({ level: 'silent' }), { minMs: 20, maxMs: 200 });
const signals: GroupSignal[] = [];
const revoked: string[] = [];
let resyncs = 0;
listener.on('group', (s) => signals.push(s));
listener.on('sessionRevoked', (id) => revoked.push(id));
listener.on('resync', () => (resyncs += 1));

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms));
const forGroup = (groupId: string) => signals.filter((s) => s.groupId === groupId);

beforeAll(async () => {
  listener.start();
  await until(() => listener.listening);
});
afterAll(async () => {
  await listener.stop();
  await Promise.all([pool.end(), owner.end()]);
});

describe('PgListener', () => {
  it('delivers one signal per committed write, in seq order', async () => {
    const g = await groupWithOwner(pool); // seq 1: group.created
    for (let i = 1; i <= 3; i++) {
      await createExpense(pool, { groupId: g.groupId, userId: g.owner, expense: expense(100 * i, g.ownerMember, [g.ownerMember]) });
    }
    await until(() => forGroup(g.groupId).length === 4);
    expect(forGroup(g.groupId).map((s) => [s.seq, s.type])).toEqual([
      [1, 'group.created'], [2, 'expense.created'], [3, 'expense.created'], [4, 'expense.created'],
    ]);
  });

  it('sends nothing for a rolled-back write', async () => {
    const g = await groupWithOwner(pool);
    await until(() => forGroup(g.groupId).length === 1);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('update groups set last_seq = last_seq + 1 where id = $1', [g.groupId]);
      await c.query(`insert into activity_log (group_id, seq, actor_user_id, type) values ($1, 2, $2, 'test.write')`, [g.groupId, g.owner]);
      await c.query('rollback');
    } finally {
      c.release();
    }
    await quiet(300);
    expect(forGroup(g.groupId).map((s) => s.seq)).toEqual([1]);
  });

  it('signals session revocation once', async () => {
    const u = await user(pool, 'Rev');
    const { token } = await createSession(pool, u);
    const { rows } = await pool.query<{ id: string }>('select id from sessions where user_id = $1', [u]);
    await revokeSession(pool, token);
    await revokeSession(pool, token); // already revoked: no second signal
    await until(() => revoked.includes(rows[0]?.id ?? ''));
    await quiet(200);
    expect(revoked.filter((id) => id === rows[0]?.id)).toHaveLength(1);
  });

  it('reconnects after its backend is killed, emits resync, and keeps delivering', async () => {
    const pid = listener.backendPid;
    expect(pid).toBeTypeOf('number');
    const before = resyncs;
    await owner.query('select pg_terminate_backend($1)', [pid]);
    await until(() => resyncs === before + 1 && listener.listening && listener.backendPid !== pid);

    const g = await groupWithOwner(pool);
    await until(() => forGroup(g.groupId).length === 1);
  });
});
