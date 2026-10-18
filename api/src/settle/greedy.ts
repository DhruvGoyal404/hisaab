import { byId, nonZeroSorted, type Balance, type Transfer } from './types.js';

type Entry = { id: string; amount: number };

/** Binary max-heap by amount; equal amounts pop in member-id order, which makes the output deterministic. */
class MaxHeap {
  private readonly items: Entry[] = [];

  get size(): number {
    return this.items.length;
  }

  private before(a: Entry, b: Entry): boolean {
    return a.amount !== b.amount ? a.amount > b.amount : byId(a.id, b.id) < 0;
  }

  push(e: Entry): void {
    const h = this.items;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = h[parent] as Entry;
      if (!this.before(e, p)) break;
      h[i] = p;
      i = parent;
    }
    h[i] = e;
  }

  pop(): Entry | undefined {
    const h = this.items;
    const top = h[0];
    const last = h.pop();
    if (top === undefined || last === undefined || h.length === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= h.length) break;
      const r = l + 1;
      const child = r < h.length && this.before(h[r] as Entry, h[l] as Entry) ? r : l;
      const c = h[child] as Entry;
      if (!this.before(c, last)) break;
      h[i] = c;
      i = child;
    }
    h[i] = last;
    return top;
  }
}

/**
 * Greedy settlement: repeatedly the largest debtor pays the largest creditor as much as one of
 * them can. Each transfer zeroes at least one member, so with k non-zero members it makes at most
 * k − 1 transfers. O(k log k). Not always minimal; see exact.ts.
 */
export function greedySettle(balances: readonly Balance[]): Transfer[] {
  const creditors = new MaxHeap();
  const debtors = new MaxHeap();
  for (const { memberId, balanceMinor } of nonZeroSorted(balances)) {
    if (balanceMinor > 0) creditors.push({ id: memberId, amount: balanceMinor });
    else debtors.push({ id: memberId, amount: -balanceMinor });
  }

  const transfers: Transfer[] = [];
  for (;;) {
    const c = creditors.pop();
    const d = debtors.pop();
    if (!c || !d) break; // the sum is zero, so both run out together
    const amountMinor = Math.min(c.amount, d.amount);
    transfers.push({ from: d.id, to: c.id, amountMinor });
    if (c.amount > amountMinor) creditors.push({ id: c.id, amount: c.amount - amountMinor });
    if (d.amount > amountMinor) debtors.push({ id: d.id, amount: d.amount - amountMinor });
  }
  return transfers;
}
