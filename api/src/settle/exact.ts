import { greedySettle } from './greedy.js';
import { nonZeroSorted, SettleError, type Balance, type Transfer } from './types.js';

/** Memory/time guard: 2^20 masks is ~10 MB of typed arrays. Above this, use greedy. */
export const MAX_EXACT_MEMBERS = 20;

const bitIndex = (bit: number): number => 31 - Math.clz32(bit);

/**
 * zero[mask] = 1 when the members in `mask` sum to 0 (mask 0 excluded). Subset sums are built
 * incrementally from the lowest set bit. Float64 is exact while every partial sum is a safe
 * integer; otherwise fall back to BigInt64 so a large group can never produce a false zero.
 */
function zeroSumMasks(values: readonly number[]): Uint8Array {
  const size = 1 << values.length;
  const zero = new Uint8Array(size);
  const absTotal = values.reduce((s, v) => s + Math.abs(v), 0);
  if (absTotal <= Number.MAX_SAFE_INTEGER) {
    const sums = new Float64Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sums[mask] = (sums[mask ^ low] as number) + (values[bitIndex(low)] as number);
      if (sums[mask] === 0) zero[mask] = 1;
    }
  } else {
    const big = values.map(BigInt);
    const sums = new BigInt64Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sums[mask] = (sums[mask ^ low] as bigint) + (big[bitIndex(low)] as bigint);
      if (sums[mask] === 0n) zero[mask] = 1;
    }
  }
  return zero;
}

/**
 * Minimum number of transfers. With k non-zero members, min = k − m where m is the largest number
 * of disjoint zero-sum groups the members can be split into (docs/ALGORITHMS.md). Bitmask DP:
 * dp[mask] = max over i in mask of dp[mask \ {i}], plus 1 if mask sums to zero. Walking back from
 * the full mask along an optimal chain, the zero-sum masks on the chain cut it into m zero-sum
 * groups; each group of size s is settled with s − 1 transfers (greedy within the group).
 * O(2^k · k) time, O(2^k) memory. Members are indexed in id order, so the output is deterministic.
 */
export function exactSettle(balances: readonly Balance[]): Transfer[] {
  const members = nonZeroSorted(balances);
  const k = members.length;
  if (k === 0) return [];
  if (k > MAX_EXACT_MEMBERS) {
    throw new SettleError(`exact settlement supports at most ${MAX_EXACT_MEMBERS} non-zero members, got ${k}`);
  }

  const size = 1 << k;
  const full = size - 1;
  const zero = zeroSumMasks(members.map((m) => m.balanceMinor));
  const dp = new Uint8Array(size);
  for (let mask = 1; mask < size; mask++) {
    let best = 0;
    for (let rest = mask; rest !== 0; rest &= rest - 1) {
      const v = dp[mask ^ (rest & -rest)] as number;
      if (v > best) best = v;
    }
    dp[mask] = best + (zero[mask] as number);
  }

  // Reconstruct: remove one member at a time along an optimal chain (lowest index first, for
  // determinism); every zero-sum mask reached closes a group.
  const groups: number[] = [];
  let groupStart = full;
  for (let mask = full; mask !== 0; ) {
    const target = (dp[mask] as number) - (zero[mask] as number);
    let next = 0;
    for (let rest = mask; rest !== 0; rest &= rest - 1) {
      const candidate = mask ^ (rest & -rest);
      if (dp[candidate] === target) {
        next = candidate;
        break;
      }
    }
    if (next === 0 || zero[next] === 1) {
      groups.push(groupStart ^ next);
      groupStart = next;
    }
    mask = next;
  }

  const transfers: Transfer[] = [];
  for (const group of groups) {
    const groupBalances = members.filter((_, i) => (group & (1 << i)) !== 0);
    transfers.push(...greedySettle(groupBalances));
  }
  return transfers;
}

