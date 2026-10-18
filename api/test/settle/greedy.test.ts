import { describe, expect, it } from 'vitest';
import { greedySettle } from '../../src/settle/greedy.js';
import { SettleError, type Balance } from '../../src/settle/types.js';

const bal = (entries: Record<string, number>): Balance[] =>
  Object.entries(entries).map(([memberId, balanceMinor]) => ({ memberId, balanceMinor }));

describe('greedySettle', () => {
  it('matches the largest debtor with the largest creditor', () => {
    expect(greedySettle(bal({ a: 700, b: -500, c: -200 }))).toEqual([
      { from: 'b', to: 'a', amountMinor: 500 },
      { from: 'c', to: 'a', amountMinor: 200 },
    ]);
  });

  it('needs 4 transfers for {+3, +2, +2, −4, −3} (the exact minimum is 3)', () => {
    const t = greedySettle(bal({ A: 3, B: 2, C: 2, D: -4, E: -3 }));
    expect(t).toEqual([
      { from: 'D', to: 'A', amountMinor: 3 },
      { from: 'E', to: 'B', amountMinor: 2 },
      { from: 'D', to: 'C', amountMinor: 1 },
      { from: 'E', to: 'C', amountMinor: 1 },
    ]);
  });

  it('breaks ties by member id, so input order does not matter', () => {
    const x = bal({ m2: 5, m1: 5, m3: -5, m4: -5 });
    expect(greedySettle(x)).toEqual(greedySettle([...x].reverse()));
    expect(greedySettle(x)).toEqual([
      { from: 'm3', to: 'm1', amountMinor: 5 },
      { from: 'm4', to: 'm2', amountMinor: 5 },
    ]);
  });

  it('returns nothing when everyone is settled, and ignores zero balances', () => {
    expect(greedySettle([])).toEqual([]);
    expect(greedySettle(bal({ a: 0, b: 0 }))).toEqual([]);
    expect(greedySettle(bal({ a: 0, b: 10, c: -10 }))).toEqual([{ from: 'c', to: 'b', amountMinor: 10 }]);
  });

  it('rejects balances that do not sum to zero, duplicates and non-integers', () => {
    expect(() => greedySettle(bal({ a: 1 }))).toThrow(SettleError);
    expect(() => greedySettle([{ memberId: 'a', balanceMinor: 1 }, { memberId: 'a', balanceMinor: -1 }])).toThrow(SettleError);
    expect(() => greedySettle(bal({ a: 0.5, b: -0.5 }))).toThrow(SettleError);
  });
});
