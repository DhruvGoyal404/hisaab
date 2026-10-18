import type pg from 'pg';
import { HttpError } from '../errors.js';
import { settle } from '../settle/auto.js';
import { MAX_EXACT_MEMBERS } from '../settle/exact.js';
import { rawDebts, type RawExpense, type RawSettlement } from '../settle/raw.js';
import type { Transfer } from '../settle/types.js';
import { selectGroupBalances } from './reads.js';
import { withGroupRead } from './tx.js';

export type SettleMode = 'auto' | 'greedy' | 'exact' | 'raw';

export type SettlePlanView = {
  groupId: string;
  /** The group's last_seq the plan was computed at. */
  seq: number;
  mode: SettleMode;
  algorithm: 'greedy' | 'exact' | 'raw';
  k: number;
  transferCount: number;
  transfers: Transfer[];
};

/** Small LRU keyed by (group, last_seq, mode). A plan is a pure function of that key's data, so entries never go stale. */
class PlanCache {
  private readonly entries = new Map<string, SettlePlanView>();
  constructor(private readonly max: number) {}

  get(key: string): SettlePlanView | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: SettlePlanView): void {
    this.entries.set(key, value);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

const cache = new PlanCache(500);

async function loadRaw(client: pg.ClientBase, groupId: string): Promise<{ expenses: RawExpense[]; settlements: RawSettlement[] }> {
  // Current, non-deleted versions only; merged ghosts resolved to their member (and combined).
  const { rows: lines } = await client.query<{ expense_id: string; member_id: string; paid: number; owed: number }>(
    `select e.id as expense_id, coalesce(m.merged_into, m.id) as member_id,
            sum(l.paid_minor)::bigint as paid, sum(l.owed_minor)::bigint as owed
       from expenses e
       join expense_versions v on v.expense_id = e.id and v.version = e.head_version and v.kind <> 'delete'
       join expense_lines l on l.expense_id = v.expense_id and l.version = v.version
       join memberships m on m.id = l.member_id
      where e.group_id = $1
      group by e.id, coalesce(m.merged_into, m.id)
      order by e.id`,
    [groupId],
  );
  const byExpense = new Map<string, RawExpense>();
  for (const l of lines) {
    const e = byExpense.get(l.expense_id) ?? { expenseId: l.expense_id, lines: [] };
    e.lines.push({ memberId: l.member_id, paidMinor: l.paid, owedMinor: l.owed });
    byExpense.set(l.expense_id, e);
  }
  const { rows: settlements } = await client.query<RawSettlement>(
    `select coalesce(f.merged_into, f.id) as "from", coalesce(t.merged_into, t.id) as "to", s.amount_minor as "amountMinor"
       from settlements s
       join memberships f on f.id = s.from_member_id
       join memberships t on t.id = s.to_member_id
      where s.group_id = $1 and not exists (select 1 from settlement_voids x where x.settlement_id = s.id)`,
    [groupId],
  );
  return { expenses: [...byExpense.values()], settlements };
}

/**
 * Suggested transfers to settle the group. Derived on read and never stored as ledger truth;
 * recording an actual payment is still createSettlement. Everything is read in one snapshot, so
 * the cache key's last_seq matches the data the plan was computed from.
 */
export function settlePlan(
  pool: pg.Pool,
  input: { groupId: string; userId: string; mode?: SettleMode },
): Promise<SettlePlanView & { cached: boolean }> {
  return withGroupRead(pool, input.groupId, input.userId, async (client) => {
    const { rows } = await client.query<{ last_seq: number; simplify_debts: boolean }>(
      'select last_seq, simplify_debts from groups where id = $1',
      [input.groupId],
    );
    const group = rows[0];
    if (!group) throw new Error('group vanished inside its own snapshot');
    const mode: SettleMode = input.mode ?? (group.simplify_debts ? 'auto' : 'raw');
    const key = `${input.groupId}:${group.last_seq}:${mode}`;
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };

    const balances = (await selectGroupBalances(client, input.groupId)).map((b) => ({ memberId: b.memberId, balanceMinor: b.balanceMinor }));
    const k = balances.filter((b) => b.balanceMinor !== 0).length;
    let plan: { algorithm: SettlePlanView['algorithm']; transfers: Transfer[] };
    if (mode === 'raw') {
      const { expenses, settlements } = await loadRaw(client, input.groupId);
      plan = { algorithm: 'raw', transfers: rawDebts(expenses, settlements) };
    } else {
      if (mode === 'exact' && k > MAX_EXACT_MEMBERS) {
        throw new HttpError(422, 'too_many_for_exact', `Exact mode supports at most ${MAX_EXACT_MEMBERS} people with a balance; use auto`);
      }
      plan = settle(balances, mode);
    }

    const view: SettlePlanView = {
      groupId: input.groupId,
      seq: group.last_seq,
      mode,
      algorithm: plan.algorithm,
      k,
      transferCount: plan.transfers.length,
      transfers: plan.transfers,
    };
    cache.set(key, view);
    return { ...view, cached: false };
  });
}
