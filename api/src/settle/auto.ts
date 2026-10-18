import { exactSettle, MAX_EXACT_MEMBERS } from './exact.js';
import { greedySettle } from './greedy.js';
import { byId, nonZeroSorted, SettleError, type Balance, type Transfer } from './types.js';

/**
 * Largest k (after pair cancellation) that auto mode solves exactly. Set from the benchmark in
 * docs/ALGORITHMS.md: exact at k = 18 stays well under the 50 ms event-loop budget.
 */
export const DEFAULT_EXACT_THRESHOLD = 18;

export type Algorithm = 'greedy' | 'exact';
export type SettlePlan = { algorithm: Algorithm; k: number; transfers: Transfer[] };

/**
 * Settles every creditor whose balance is exactly matched by a debtor's (+x, −x) with one
 * transfer. Never costs optimality: an optimal partition can always be rearranged so such a
 * pair is its own zero-sum group (docs/ALGORITHMS.md). Pairs are matched in member-id order.
 */
export function cancelOppositePairs(members: readonly Balance[]): { pairs: Transfer[]; rest: Balance[] } {
  const debtorsByAmount = new Map<number, string[]>();
  for (const m of members) {
    if (m.balanceMinor < 0) {
      const list = debtorsByAmount.get(-m.balanceMinor) ?? [];
      list.push(m.memberId);
      debtorsByAmount.set(-m.balanceMinor, list);
    }
  }
  for (const list of debtorsByAmount.values()) list.sort(byId);

  const paired = new Set<string>();
  const pairs: Transfer[] = [];
  for (const m of [...members].sort((a, b) => byId(a.memberId, b.memberId))) {
    if (m.balanceMinor <= 0) continue;
    const debtor = debtorsByAmount.get(m.balanceMinor)?.shift();
    if (debtor === undefined) continue;
    pairs.push({ from: debtor, to: m.memberId, amountMinor: m.balanceMinor });
    paired.add(debtor).add(m.memberId);
  }
  return { pairs, rest: members.filter((m) => !paired.has(m.memberId)) };
}

/** Exact when the members left after pair cancellation fit under `threshold`, greedy otherwise. */
export function autoSettle(balances: readonly Balance[], threshold = DEFAULT_EXACT_THRESHOLD): SettlePlan {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > MAX_EXACT_MEMBERS) {
    throw new SettleError(`threshold must be between 0 and ${MAX_EXACT_MEMBERS}`);
  }
  const members = nonZeroSorted(balances);
  const { pairs, rest } = cancelOppositePairs(members);
  const algorithm: Algorithm = rest.length <= threshold ? 'exact' : 'greedy';
  const restTransfers = algorithm === 'exact' ? exactSettle(rest) : greedySettle(rest);
  return { algorithm, k: members.length, transfers: [...pairs, ...restTransfers] };
}

/** One entry point for the three computed modes (raw lives in raw.ts: it needs expense data). */
export function settle(balances: readonly Balance[], mode: 'auto' | 'greedy' | 'exact'): SettlePlan {
  if (mode === 'auto') return autoSettle(balances);
  const k = nonZeroSorted(balances).length;
  return { algorithm: mode, k, transfers: mode === 'exact' ? exactSettle(balances) : greedySettle(balances) };
}
