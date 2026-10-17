import { createHash } from 'node:crypto';

/** ₹100 crore in paise: the largest expense total (matches the DB check). */
export const MAX_TOTAL_MINOR = 100_000_000_000;
/** Percentages are basis points: 100% = 10000, so 0.01% precision. */
export const PERCENT_SCALE = 10_000;
export const MAX_SHARES = 1_000_000;

export type SplitMethod = 'equal' | 'exact' | 'percent' | 'shares';

/** equal: weight 1 each; exact: the paise owed; percent: basis points (sum 10000); shares: integer shares. */
export type WeightInput = { memberId: string; weight: number };

export type Allocation = { memberId: string; weight: number; owedMinor: number };

export class AllocationError extends Error {
  override name = 'AllocationError';
}

function tiebreakKey(seed: string, memberId: string): string {
  return createHash('sha256').update(seed).update('\u0000').update(memberId).digest('hex');
}

function validate(totalMinor: number, method: SplitMethod, weights: readonly WeightInput[]): void {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || totalMinor > MAX_TOTAL_MINOR) {
    throw new AllocationError(`total must be an integer number of paise between 0 and ${MAX_TOTAL_MINOR}`);
  }
  if (weights.length === 0) throw new AllocationError('at least one participant is required');
  const seen = new Set<string>();
  let sum = 0;
  for (const { memberId, weight } of weights) {
    if (memberId === '' || seen.has(memberId)) throw new AllocationError(`duplicate or empty member id "${memberId}"`);
    seen.add(memberId);
    if (!Number.isSafeInteger(weight) || weight < 1) throw new AllocationError('weights must be positive integers');
    sum += weight;
  }
  switch (method) {
    case 'equal':
      if (weights.some((w) => w.weight !== 1)) throw new AllocationError('equal splits use weight 1 for everyone');
      break;
    case 'exact':
      if (sum !== totalMinor) throw new AllocationError(`exact amounts sum to ${sum}, not the total ${totalMinor}`);
      break;
    case 'percent':
      if (sum !== PERCENT_SCALE) throw new AllocationError(`percentages sum to ${sum / 100}%, not 100%`);
      break;
    case 'shares':
      if (weights.some((w) => w.weight > MAX_SHARES)) throw new AllocationError(`a share count exceeds ${MAX_SHARES}`);
      break;
  }
}

/**
 * The only place money is divided. Splits `totalMinor` paise across `weights` by the largest
 * remainder method: everyone gets floor(total * w / W); the leftover paise (fewer than the number
 * of participants) go one each to the largest remainders. Remainder ties are broken by
 * sha256(seed, memberId), so the result is deterministic, independent of input order, and does not
 * always favour the same person. Pass the expense id as `seed` so edits keep the same tie order.
 *
 * Guarantees, also checked by the database at commit: shares sum to the total, and each share is
 * floor or ceil of its exact value. Returned in memberId order.
 */
export function allocate(
  totalMinor: number,
  method: SplitMethod,
  weights: readonly WeightInput[],
  seed: string,
): Allocation[] {
  validate(totalMinor, method, weights);

  // BigInt: total * weight can reach 1e22 for exact splits, beyond Number's safe range.
  const total = BigInt(totalMinor);
  const weightSum = weights.reduce((s, w) => s + BigInt(w.weight), 0n);
  const rows = weights.map(({ memberId, weight }) => {
    const scaled = total * BigInt(weight);
    return { memberId, weight, owed: scaled / weightSum, remainder: scaled % weightSum, key: tiebreakKey(seed, memberId) };
  });

  let leftover = total - rows.reduce((s, r) => s + r.owed, 0n);
  const byPriority = [...rows].sort((a, b) =>
    a.remainder !== b.remainder ? (b.remainder > a.remainder ? 1 : -1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const row of byPriority) {
    if (leftover === 0n) break;
    row.owed += 1n;
    leftover -= 1n;
  }

  return rows
    .map(({ memberId, weight, owed }) => ({ memberId, weight, owedMinor: Number(owed) }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}
