import { largestRemainder } from '../domain/allocate.js';
import { byId, SettleError, type Transfer } from './types.js';

/** A current (head, not deleted) expense version, with members already resolved to effective ids. */
export type RawExpense = { expenseId: string; lines: { memberId: string; paidMinor: number; owedMinor: number }[] };
export type RawSettlement = { from: string; to: string; amountMinor: number };

/**
 * Who owes whom without simplification: each participant owes the people who paid for that
 * expense, netted per pair across all expenses and settlements.
 *
 * With several payers, participants are taken in member-id order and each one's share is split
 * across the payers in proportion to what each payer still has to be repaid (largest remainder,
 * the same core as allocate()). That stays close to proportional and keeps both margins exact:
 * every participant owes exactly their share and every payer is owed exactly what they paid, so
 * applying these transfers zeroes the same balances the ledger shows.
 */
export function rawDebts(expenses: readonly RawExpense[], settlements: readonly RawSettlement[]): Transfer[] {
  // net.get(`${a}\u0000${b}`) with a < b: positive = a owes b, negative = b owes a.
  const net = new Map<string, number>();
  const owe = (debtor: string, creditor: string, amount: number) => {
    if (debtor === creditor || amount === 0) return;
    const [a, b, sign] = debtor < creditor ? [debtor, creditor, 1] : [creditor, debtor, -1];
    const key = `${a}\u0000${b}`;
    net.set(key, (net.get(key) ?? 0) + sign * amount);
  };

  for (const { expenseId, lines } of expenses) {
    const paid = lines.reduce((s, l) => s + l.paidMinor, 0);
    const owed = lines.reduce((s, l) => s + l.owedMinor, 0);
    if (paid !== owed) throw new SettleError(`expense ${expenseId}: paid ${paid} != owed ${owed}`);

    const remaining = new Map(
      lines.filter((l) => l.paidMinor > 0).sort((x, y) => byId(x.memberId, y.memberId)).map((l) => [l.memberId, l.paidMinor]),
    );
    const participants = lines.filter((l) => l.owedMinor > 0).sort((x, y) => byId(x.memberId, y.memberId));
    for (const p of participants) {
      const payers = [...remaining].filter(([, cap]) => cap > 0).map(([memberId, weight]) => ({ memberId, weight }));
      for (const share of largestRemainder(p.owedMinor, payers, `${expenseId}:${p.memberId}`)) {
        remaining.set(share.memberId, (remaining.get(share.memberId) ?? 0) - share.owedMinor);
        owe(p.memberId, share.memberId, share.owedMinor);
      }
    }
  }

  // Paying someone reduces what you owe them.
  for (const s of settlements) owe(s.to, s.from, s.amountMinor);

  const transfers: Transfer[] = [];
  for (const [key, amount] of net) {
    if (amount === 0) continue;
    const [a = '', b = ''] = key.split('\u0000');
    transfers.push(amount > 0 ? { from: a, to: b, amountMinor: amount } : { from: b, to: a, amountMinor: -amount });
  }
  return transfers.sort((x, y) => byId(x.from, y.from) || byId(x.to, y.to));
}
