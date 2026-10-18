/** Net balance of one effective member, in paise: positive = owed money (creditor), negative = owes (debtor). */
export type Balance = { memberId: string; balanceMinor: number };

/** `from` pays `to` this many paise. */
export type Transfer = { from: string; to: string; amountMinor: number };

export class SettleError extends Error {
  override name = 'SettleError';
}

export const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Checks the input every algorithm relies on (safe integers, unique ids, sum zero) and returns the
 * non-zero balances sorted by member id, the canonical order that makes every algorithm deterministic.
 */
export function nonZeroSorted(balances: readonly Balance[]): Balance[] {
  const seen = new Set<string>();
  let sum = 0n;
  for (const { memberId, balanceMinor } of balances) {
    if (seen.has(memberId)) throw new SettleError(`duplicate member ${memberId}`);
    seen.add(memberId);
    if (!Number.isSafeInteger(balanceMinor)) throw new SettleError(`balance of ${memberId} is not a safe integer`);
    sum += BigInt(balanceMinor);
  }
  if (sum !== 0n) throw new SettleError(`balances sum to ${sum}, not 0`);
  return balances
    .filter((b) => b.balanceMinor !== 0)
    .map((b) => ({ memberId: b.memberId, balanceMinor: b.balanceMinor }))
    .sort((a, b) => byId(a.memberId, b.memberId));
}
