import { describe, expect, it } from 'vitest';
import { autoSettle, cancelOppositePairs, DEFAULT_EXACT_THRESHOLD, settle } from '../../src/settle/auto.js';
import { SettleError, type Balance } from '../../src/settle/types.js';

const bal = (entries: Record<string, number>): Balance[] =>
  Object.entries(entries).map(([memberId, balanceMinor]) => ({ memberId, balanceMinor }));

/** n members with no zero-sum proper subset (powers of two plus one balancing debtor). */
const unpairable = (n: number): Balance[] => {
  const credits = Array.from({ length: n - 1 }, (_, i) => ({ memberId: `c${String(i).padStart(2, '0')}`, balanceMinor: 2 ** i }));
  return [...credits, { memberId: 'debtor', balanceMinor: -(2 ** (n - 1) - 1) }];
};

describe('cancelOppositePairs', () => {
  it('pairs exact opposites in id order and leaves the rest', () => {
    const { pairs, rest } = cancelOppositePairs(bal({ a: 5, b: 5, c: -5, d: -5, e: 3, f: -3, g: 1, h: -1 }));
    expect(pairs).toEqual([
      { from: 'c', to: 'a', amountMinor: 5 },
      { from: 'd', to: 'b', amountMinor: 5 },
      { from: 'f', to: 'e', amountMinor: 3 },
      { from: 'h', to: 'g', amountMinor: 1 },
    ]);
    expect(rest).toEqual([]);
  });
});

describe('autoSettle', () => {
  it(`uses exact up to ${DEFAULT_EXACT_THRESHOLD} remaining members and greedy above`, () => {
    expect(autoSettle(unpairable(DEFAULT_EXACT_THRESHOLD))).toMatchObject({ algorithm: 'exact', k: DEFAULT_EXACT_THRESHOLD });
    expect(autoSettle(unpairable(DEFAULT_EXACT_THRESHOLD + 1))).toMatchObject({ algorithm: 'greedy', k: DEFAULT_EXACT_THRESHOLD + 1 });
  });

  it('counts k before pair cancellation but decides on what remains', () => {
    const many = [...unpairable(10), ...Array.from({ length: 15 }, (_, i) => [
      { memberId: `p${String(i).padStart(2, '0')}`, balanceMinor: 1000 + i },
      { memberId: `q${String(i).padStart(2, '0')}`, balanceMinor: -(1000 + i) },
    ]).flat()];
    const plan = autoSettle(many);
    expect(plan).toMatchObject({ algorithm: 'exact', k: 40 });
    expect(plan.transfers).toHaveLength(15 + 9);
  });

  it('beats greedy on the regression case', () => {
    expect(autoSettle(bal({ A: 3, B: 2, C: 2, D: -4, E: -3 })).transfers).toHaveLength(3);
    expect(settle(bal({ A: 3, B: 2, C: 2, D: -4, E: -3 }), 'greedy').transfers).toHaveLength(4);
  });

  it('rejects an out-of-range threshold', () => {
    expect(() => autoSettle([], 99)).toThrow(SettleError);
  });
});
