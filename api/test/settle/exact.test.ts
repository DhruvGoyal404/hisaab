import { describe, expect, it } from 'vitest';
import { exactSettle, MAX_EXACT_MEMBERS } from '../../src/settle/exact.js';
import { greedySettle } from '../../src/settle/greedy.js';
import { SettleError, type Balance, type Transfer } from '../../src/settle/types.js';

const bal = (entries: Record<string, number>): Balance[] =>
  Object.entries(entries).map(([memberId, balanceMinor]) => ({ memberId, balanceMinor }));

function apply(balances: Balance[], transfers: Transfer[]): Record<string, number> {
  const out = Object.fromEntries(balances.map((b) => [b.memberId, b.balanceMinor]));
  for (const t of transfers) {
    out[t.from] = (out[t.from] ?? 0) + t.amountMinor;
    out[t.to] = (out[t.to] ?? 0) - t.amountMinor;
  }
  return out;
}

describe('exactSettle', () => {
  it('settles {+3, +2, +2, −4, −3} in 3 transfers where greedy needs 4', () => {
    const b = bal({ A: 3, B: 2, C: 2, D: -4, E: -3 });
    const t = exactSettle(b);
    expect(t).toHaveLength(3);
    expect(greedySettle(b)).toHaveLength(4);
    expect(Object.values(apply(b, t)).every((v) => v === 0)).toBe(true);
    // The zero-sum groups are {A, E} and {B, C, D}.
    expect(t).toEqual(expect.arrayContaining([
      { from: 'E', to: 'A', amountMinor: 3 },
      { from: 'D', to: 'B', amountMinor: 2 },
      { from: 'D', to: 'C', amountMinor: 2 },
    ]));
  });

  it('finds several independent zero-sum groups', () => {
    const b = bal({ a: 10, b: -10, c: 7, d: -3, e: -4, f: 1, g: -1 });
    const t = exactSettle(b);
    expect(t).toHaveLength(7 - 3);
    expect(Object.values(apply(b, t)).every((v) => v === 0)).toBe(true);
  });

  it('needs k − 1 transfers when no proper subset sums to zero', () => {
    expect(exactSettle(bal({ a: 5, b: 4, c: -6, d: -3 }))).toHaveLength(3);
  });

  it('is exact for balances whose subset sums exceed 2^53', () => {
    const big = 4_000_000_000_000_000; // 4e15: pairs of these overflow Number's exact range
    const b = bal({ a: big, b: big, c: -big, d: -big, e: 3, f: -3 });
    const t = exactSettle(b);
    expect(t).toHaveLength(3);
    expect(Object.values(apply(b, t)).every((v) => v === 0)).toBe(true);
  });

  it('handles nobody owing anything', () => {
    expect(exactSettle([])).toEqual([]);
    expect(exactSettle(bal({ a: 0 }))).toEqual([]);
  });

  it(`refuses more than ${MAX_EXACT_MEMBERS} non-zero members`, () => {
    const many = Array.from({ length: MAX_EXACT_MEMBERS + 1 }, (_, i) => ({ memberId: `m${String(i).padStart(2, '0')}`, balanceMinor: 1 }));
    many.push({ memberId: 'zz', balanceMinor: -(MAX_EXACT_MEMBERS + 1) });
    expect(() => exactSettle(many)).toThrow(SettleError);
  });
});
