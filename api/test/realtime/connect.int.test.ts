import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExpense } from '../../src/repo/expenses.js';
import { createGroup } from '../../src/repo/groups.js';
import { expense } from '../db/fixtures.js';
import { recorder, startStack, until } from './harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.close());

describe('socket server', () => {
  it('accepts a valid session, joins the user\'s groups, and delivers a committed write', async () => {
    const asha = await stack.login(`Asha-${Date.now()}`);
    const { groupId, memberId } = await createGroup(stack.pool, { userId: asha.userId, name: 'Goa' });
    const s = stack.socket({ cookie: asha.cookie });
    expect(await stack.ready(s)).toEqual([groupId]);

    const got = recorder(s);
    await createExpense(stack.pool, { groupId, userId: asha.userId, expense: expense(500, memberId, [memberId]) });
    await until(() => got.length === 1);
    expect(got).toEqual([{ groupId, seq: 2 }]);
  });

  it('answers sync with the groups the client is behind on', async () => {
    const bilal = await stack.login(`Bilal-${Date.now()}`);
    const a = await createGroup(stack.pool, { userId: bilal.userId, name: 'A' });
    const b = await createGroup(stack.pool, { userId: bilal.userId, name: 'B' });
    await createExpense(stack.pool, { groupId: a.groupId, userId: bilal.userId, expense: expense(100, a.memberId, [a.memberId]) });
    const s = stack.socket({ cookie: bilal.cookie });
    await stack.ready(s);
    const got = recorder(s);
    s.emit('sync', { [a.groupId]: 1, [b.groupId]: 1 }); // a is at seq 2, b at 1
    await until(() => got.length === 1);
    expect(got).toEqual([{ groupId: a.groupId, seq: 2 }]);
  });
});
