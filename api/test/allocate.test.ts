import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  AllocationError,
  MAX_SHARES,
  MAX_TOTAL_MINOR,
  PERCENT_SCALE,
  type SplitMethod,
  type WeightInput,
} from '../src/domain/allocate.js';
import { propertyTimeout, runs } from './fc.js';

const RUNS = runs(2_000);

const memberIds = (n: number) => fc.uniqueArray(fc.uuid(), { minLength: n, maxLength: n });

// Totals biased towards the edges: 0, 1, small, and the maximum.
const total = fc.oneof(
  fc.constantFrom(0, 1, 2, 99, 100, MAX_TOTAL_MINOR - 1, MAX_TOTAL_MINOR),
  fc.integer({ min: 0, max: 10_000 }),
  fc.integer({ min: 0, max: MAX_TOTAL_MINOR }),
);

/** n positive integers summing to `sum` (n ≤ sum), as cut points of [1, sum - 1]. */
const partition = (n: number, sum: number) =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: sum - 1 }), { minLength: n - 1, maxLength: n - 1 })
    .map((cuts) => {
      const points = [0, ...cuts.sort((a, b) => a - b), sum];
      return points.slice(1).map((p, i) => p - (points[i] ?? 0));
    });

type Case = { method: SplitMethod; total: number; weights: WeightInput[]; seed: string };

const withIds = (ids: string[], ws: number[]): WeightInput[] => ids.map((memberId, i) => ({ memberId, weight: ws[i] ?? 1 }));

const anyCase: fc.Arbitrary<Case> = fc
  .record({ n: fc.integer({ min: 1, max: 150 }), seed: fc.string(), method: fc.constantFrom<SplitMethod>('equal', 'exact', 'percent', 'shares') })
  .chain(({ n, seed, method }): fc.Arbitrary<Case> => {
    switch (method) {
      case 'equal':
        return fc.record({ ids: memberIds(n), total }).map(({ ids, total }) => ({
          method, seed, total, weights: withIds(ids, ids.map(() => 1)),
        }));
      case 'shares':
        return fc
          .record({ ids: memberIds(n), total, ws: fc.array(fc.integer({ min: 1, max: MAX_SHARES }), { minLength: n, maxLength: n }) })
          .map(({ ids, total, ws }) => ({ method, seed, total, weights: withIds(ids, ws) }));
      case 'percent':
        return fc
          .record({ ids: memberIds(n), total, ws: partition(n, PERCENT_SCALE) })
          .map(({ ids, total, ws }) => ({ method, seed, total, weights: withIds(ids, ws) }));
      case 'exact':
        return fc
          .record({ ids: memberIds(n), t: fc.integer({ min: n, max: MAX_TOTAL_MINOR }) })
          .chain(({ ids, t }) => partition(n, t).map((ws) => ({ method, seed, total: t, weights: withIds(ids, ws) })));
    }
  });

const run = (c: Case) => allocate(c.total, c.method, c.weights, c.seed);

describe('allocate: properties', { timeout: propertyTimeout() }, () => {
  it('shares always sum to the total', () => {
    fc.assert(fc.property(anyCase, (c) => {
      expect(run(c).reduce((s, a) => s + a.owedMinor, 0)).toBe(c.total);
    }), RUNS);
  });

  it('every share is floor or ceil of total * weight / sum(weights)', () => {
    fc.assert(fc.property(anyCase, (c) => {
      const W = c.weights.reduce((s, w) => s + BigInt(w.weight), 0n);
      for (const a of run(c)) {
        const exactTimesW = BigInt(c.total) * BigInt(a.weight);
        const owedTimesW = BigInt(a.owedMinor) * W;
        const diff = owedTimesW > exactTimesW ? owedTimesW - exactTimesW : exactTimesW - owedTimesW;
        expect(diff < W).toBe(true);
        expect(Number.isSafeInteger(a.owedMinor) && a.owedMinor >= 0).toBe(true);
      }
    }), RUNS);
  });

  it('is deterministic for the same inputs', () => {
    fc.assert(fc.property(anyCase, (c) => {
      expect(run(c)).toEqual(run(structuredClone(c)));
    }), RUNS);
  });

  it('does not depend on the order of participants', () => {
    fc.assert(fc.property(anyCase, fc.integer(), (c, salt) => {
      const shuffled = [...c.weights].sort((a, b) => ((a.memberId.charCodeAt(salt & 7) ^ salt) - (b.memberId.charCodeAt(salt & 7) ^ salt)));
      expect(allocate(c.total, c.method, shuffled, c.seed)).toEqual(run(c));
    }), RUNS);
  });

  it('returns one row per participant with the weight it was given', () => {
    fc.assert(fc.property(anyCase, (c) => {
      const out = run(c);
      expect(out.map((a) => [a.memberId, a.weight]).sort()).toEqual(c.weights.map((w) => [w.memberId, w.weight]).sort());
    }), RUNS);
  });

  it('exact splits come back unchanged', () => {
    fc.assert(fc.property(anyCase.filter((c) => c.method === 'exact'), (c) => {
      for (const a of run(c)) expect(a.owedMinor).toBe(a.weight);
    }), runs(500));
  });
});

describe('allocate: edge cases', () => {
  it('gives a single member the whole total', () => {
    fc.assert(fc.property(total, fc.uuid(), fc.constantFrom<SplitMethod>('equal', 'shares'), (t, id, method) => {
      expect(allocate(t, method, [{ memberId: id, weight: 1 }], 'seed')).toEqual([{ memberId: id, weight: 1, owedMinor: t }]);
    }));
    expect(allocate(5000, 'percent', [{ memberId: 'a', weight: 10_000 }], 's')[0]?.owedMinor).toBe(5000);
  });

  it('splits zero as all zeros', () => {
    const out = allocate(0, 'shares', [{ memberId: 'a', weight: 3 }, { memberId: 'b', weight: 5 }], 's');
    expect(out.map((a) => a.owedMinor)).toEqual([0, 0]);
  });

  it('handles the maximum total across 150 members', () => {
    const weights = Array.from({ length: 150 }, (_, i) => ({ memberId: `m${String(i).padStart(3, '0')}`, weight: 1 }));
    const out = allocate(MAX_TOTAL_MINOR, 'equal', weights, 'seed');
    expect(out.reduce((s, a) => s + a.owedMinor, 0)).toBe(MAX_TOTAL_MINOR);
    // 1e11 / 150 = 666666666.67: 100 members get the ceiling, 50 the floor.
    expect(out.filter((a) => a.owedMinor === 666_666_667)).toHaveLength(100);
    expect(out.filter((a) => a.owedMinor === 666_666_666)).toHaveLength(50);
  });

  it('matches the worked example: ₹10.00 at 33.33/33.33/33.34%', () => {
    const out = allocate(1000, 'percent', [
      { memberId: 'asha', weight: 3333 }, { memberId: 'bilal', weight: 3333 }, { memberId: 'chirag', weight: 3334 },
    ], 'expense-1');
    expect(out).toEqual([
      { memberId: 'asha', weight: 3333, owedMinor: 333 },
      { memberId: 'bilal', weight: 3333, owedMinor: 333 },
      { memberId: 'chirag', weight: 3334, owedMinor: 334 },
    ]);
  });

  it('uses the seed to decide who absorbs a tied leftover paisa', () => {
    const three = ['a', 'b', 'c'].map((memberId) => ({ memberId, weight: 1 }));
    const winners = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const out = allocate(100, 'equal', three, `expense-${i}`);
      expect(out.map((a) => a.owedMinor).sort()).toEqual([33, 33, 34]);
      winners.add(out.find((a) => a.owedMinor === 34)?.memberId ?? '');
    }
    expect(winners.size).toBe(3);
  });

  it.each([
    ['negative total', -1, 'equal', [{ memberId: 'a', weight: 1 }]],
    ['total above the cap', MAX_TOTAL_MINOR + 1, 'equal', [{ memberId: 'a', weight: 1 }]],
    ['fractional total', 10.5, 'equal', [{ memberId: 'a', weight: 1 }]],
    ['no participants', 100, 'equal', []],
    ['duplicate member', 100, 'equal', [{ memberId: 'a', weight: 1 }, { memberId: 'a', weight: 1 }]],
    ['equal with weight 2', 100, 'equal', [{ memberId: 'a', weight: 2 }]],
    ['zero weight', 100, 'shares', [{ memberId: 'a', weight: 0 }]],
    ['percent not 100%', 100, 'percent', [{ memberId: 'a', weight: 5000 }, { memberId: 'b', weight: 4999 }]],
    ['exact not summing to total', 100, 'exact', [{ memberId: 'a', weight: 60 }, { memberId: 'b', weight: 39 }]],
    ['too many shares', 100, 'shares', [{ memberId: 'a', weight: MAX_SHARES + 1 }]],
  ] as const)('rejects %s', (_label, t, method, weights) => {
    expect(() => allocate(t, method, weights, 's')).toThrow(AllocationError);
  });
});
