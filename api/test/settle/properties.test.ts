import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate } from '../../src/domain/allocate.js';
import { autoSettle, DEFAULT_EXACT_THRESHOLD } from '../../src/settle/auto.js';
import { exactSettle } from '../../src/settle/exact.js';
import { greedySettle } from '../../src/settle/greedy.js';
import { rawDebts, type RawExpense, type RawSettlement } from '../../src/settle/raw.js';
import type { Balance, Transfer } from '../../src/settle/types.js';
import { propertyTimeout, runs } from '../fc.js';

const RUNS = runs(10_000);

/** n member ids, distinct and in random order. */
const ids = (n: number) => fc.uniqueArray(fc.uuid(), { minLength: n, maxLength: n });

/**
 * Zero-sum balances for up to `maxK` members. Small magnitudes make zero-sum subsets (where exact
 * beats greedy) common; large ones exercise big numbers. Some members may be zero.
 */
const balances = (maxK: number) =>
  fc
    .integer({ min: 0, max: maxK })
    .chain((n) =>
      fc.record({
        ids: ids(n),
        values: fc.oneof(
          fc.array(fc.integer({ min: -12, max: 12 }), { minLength: Math.max(0, n - 1), maxLength: Math.max(0, n - 1) }),
          fc.array(fc.integer({ min: -1e12, max: 1e12 }), { minLength: Math.max(0, n - 1), maxLength: Math.max(0, n - 1) }),
        ),
      }),
    )
    .map(({ ids: memberIds, values }): Balance[] => {
      if (memberIds.length === 0) return [];
      const all = [...values, 0 - values.reduce((s, v) => s + v, 0)]; // 0 - x, not -x: no -0
      return memberIds.map((memberId, i) => ({ memberId, balanceMinor: all[i] ?? 0 }));
    });

const nonZero = (b: readonly Balance[]) => b.filter((x) => x.balanceMinor !== 0).length;

/**
 * Every validity property a plan must have, against the balances it settles. Simplified plans
 * also only move money from net debtors to net creditors; the raw view need not (you can owe one
 * friend while being owed more by another).
 */
function expectValidPlan(input: readonly Balance[], transfers: readonly Transfer[], simplified = true): void {
  const left = new Map(input.map((b) => [b.memberId, b.balanceMinor]));
  for (const t of transfers) {
    expect(Number.isSafeInteger(t.amountMinor) && t.amountMinor > 0).toBe(true);
    expect(t.from).not.toBe(t.to);
    if (simplified) {
      expect(input.find((b) => b.memberId === t.from)?.balanceMinor ?? 0).toBeLessThan(0); // only debtors pay
      expect(input.find((b) => b.memberId === t.to)?.balanceMinor ?? 0).toBeGreaterThan(0); // only creditors receive
    }
    left.set(t.from, (left.get(t.from) ?? 0) + t.amountMinor);
    left.set(t.to, (left.get(t.to) ?? 0) - t.amountMinor);
  }
  for (const v of left.values()) expect(v === 0).toBe(true); // === treats -0 as 0, like the algorithms
}

/** Minimum transfers by brute force: k minus the most zero-sum blocks over all set partitions. */
function bruteForceMinimum(input: readonly Balance[]): number {
  const values = input.map((b) => b.balanceMinor).filter((v) => v !== 0);
  let best = 0;
  const blocks: number[] = [];
  const visit = (i: number) => {
    if (i === values.length) {
      if (blocks.every((s) => s === 0)) best = Math.max(best, blocks.length);
      return;
    }
    const v = values[i] ?? 0;
    for (let b = 0; b < blocks.length; b++) {
      blocks[b] = (blocks[b] ?? 0) + v;
      visit(i + 1);
      blocks[b] = (blocks[b] ?? 0) - v;
    }
    blocks.push(v);
    visit(i + 1);
    blocks.pop();
  };
  visit(0);
  return values.length - best;
}

const shuffle = (b: readonly Balance[], seed: number) =>
  [...b].sort((x, y) => ((x.memberId.charCodeAt(seed & 15) * 31) ^ seed) - ((y.memberId.charCodeAt(seed & 15) * 31) ^ seed));

describe('settlement properties', { timeout: propertyTimeout() }, () => {
  it('greedy: a valid plan with at most k − 1 transfers', () => {
    fc.assert(fc.property(balances(40), (b) => {
      const t = greedySettle(b);
      expectValidPlan(b, t);
      expect(t.length).toBeLessThanOrEqual(Math.max(0, nonZero(b) - 1));
    }), RUNS);
  });

  it('exact: a valid plan, never more transfers than greedy', () => {
    fc.assert(fc.property(balances(12), (b) => {
      const t = exactSettle(b);
      expectValidPlan(b, t);
      expect(t.length).toBeLessThanOrEqual(greedySettle(b).length);
    }), RUNS);
  });

  it('exact equals the brute-force minimum for k ≤ 7', () => {
    fc.assert(fc.property(balances(7), (b) => {
      expect(exactSettle(b).length).toBe(bruteForceMinimum(b));
    }), RUNS);
  });

  it(`auto: valid, ≤ greedy, and minimal while k ≤ ${DEFAULT_EXACT_THRESHOLD}`, () => {
    fc.assert(fc.property(balances(12), (b) => {
      const plan = autoSettle(b);
      expectValidPlan(b, plan.transfers);
      expect(plan.k).toBe(nonZero(b));
      expect(plan.transfers.length).toBeLessThanOrEqual(greedySettle(b).length);
      expect(plan.transfers.length).toBe(exactSettle(b).length);
    }), RUNS);
  });

  it('auto stays valid and ≤ k − 1 above the threshold (greedy fallback after pair cancellation)', () => {
    fc.assert(fc.property(balances(60), (b) => {
      const plan = autoSettle(b, 6);
      expectValidPlan(b, plan.transfers);
      expect(plan.transfers.length).toBeLessThanOrEqual(Math.max(0, nonZero(b) - 1));
    }), runs(2_000));
  });

  it('every algorithm is deterministic and independent of input order', () => {
    fc.assert(fc.property(balances(10), fc.integer(), (b, seed) => {
      const shuffled = shuffle(b, seed);
      expect(greedySettle(shuffled)).toEqual(greedySettle(b));
      expect(exactSettle(shuffled)).toEqual(exactSettle(b));
      expect(autoSettle(shuffled)).toEqual(autoSettle(b));
      expect(exactSettle(b)).toEqual(exactSettle(structuredClone(b)));
    }), RUNS);
  });

  it('regression: {+3, +2, +2, −4, −3} needs 4 transfers greedily and 3 exactly', () => {
    const b: Balance[] = [['A', 3], ['B', 2], ['C', 2], ['D', -4], ['E', -3]].map(([memberId, balanceMinor]) => ({
      memberId: memberId as string, balanceMinor: balanceMinor as number,
    }));
    expect(greedySettle(b)).toHaveLength(4);
    expect(exactSettle(b)).toHaveLength(3);
    expect(bruteForceMinimum(b)).toBe(3);
    expect(autoSettle(b).transfers).toHaveLength(3);
  });
});

// Raw view: random groups of expenses (equal splits, one or more payers) and settlements.
type RawGroup = {
  members: string[];
  expenses: { total: number; payers: string[]; participants: string[]; payerWeights: number[] }[];
  settlements: RawSettlement[];
};

const rawGroup: fc.Arbitrary<RawGroup> = fc.integer({ min: 2, max: 8 }).chain((n) =>
  ids(n).chain((members) =>
    fc.record({
      members: fc.constant(members),
      expenses: fc.array(
        fc.record({
          total: fc.integer({ min: 1, max: 1_000_000 }),
          payers: fc.subarray(members, { minLength: 1 }),
          participants: fc.subarray(members, { minLength: 1 }),
          payerWeights: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: n, maxLength: n }),
        }),
        { maxLength: 6 },
      ),
      settlements: fc.array(
        fc.record({ from: fc.constantFrom(...members), to: fc.constantFrom(...members), amountMinor: fc.integer({ min: 1, max: 500_000 }) })
          .filter((s) => s.from !== s.to),
        { maxLength: 4 },
      ),
    }),
  ),
);

function toRaw(g: RawGroup): { expenses: RawExpense[]; settlements: RawSettlement[]; balances: Balance[] } {
  const balance = new Map(g.members.map((m) => [m, 0]));
  const expenses = g.expenses.map((e, i): RawExpense => {
    const expenseId = `e${i}`;
    const paid = allocate(e.total, 'shares', e.payers.map((memberId, j) => ({ memberId, weight: e.payerWeights[j] ?? 1 })), expenseId);
    const owed = allocate(e.total, 'equal', e.participants.map((memberId) => ({ memberId, weight: 1 })), expenseId);
    const lines = new Map<string, { memberId: string; paidMinor: number; owedMinor: number }>();
    const line = (id: string) => {
      let l = lines.get(id);
      if (!l) lines.set(id, (l = { memberId: id, paidMinor: 0, owedMinor: 0 }));
      return l;
    };
    for (const p of paid) line(p.memberId).paidMinor += p.owedMinor;
    for (const o of owed) line(o.memberId).owedMinor += o.owedMinor;
    for (const l of lines.values()) balance.set(l.memberId, (balance.get(l.memberId) ?? 0) + l.paidMinor - l.owedMinor);
    return { expenseId, lines: [...lines.values()] };
  });
  for (const s of g.settlements) {
    balance.set(s.from, (balance.get(s.from) ?? 0) + s.amountMinor);
    balance.set(s.to, (balance.get(s.to) ?? 0) - s.amountMinor);
  }
  return { expenses, settlements: g.settlements, balances: [...balance].map(([memberId, balanceMinor]) => ({ memberId, balanceMinor })) };
}

describe('raw view properties', { timeout: propertyTimeout() }, () => {
  it('pairwise debts settle exactly the ledger balances, one transfer per pair at most', () => {
    fc.assert(fc.property(rawGroup, (g) => {
      const { expenses, settlements, balances: b } = toRaw(g);
      const t = rawDebts(expenses, settlements);
      expectValidPlan(b, t, false);
      const pairs = t.map((x) => [x.from, x.to].sort().join('|'));
      expect(new Set(pairs).size).toBe(pairs.length);
    }), RUNS);
  });

  it('does not depend on the order of expenses or settlements', () => {
    fc.assert(fc.property(rawGroup, (g) => {
      const { expenses, settlements } = toRaw(g);
      expect(rawDebts([...expenses].reverse(), [...settlements].reverse())).toEqual(rawDebts(expenses, settlements));
    }), RUNS);
  });
});
