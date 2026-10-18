import { allocate, AllocationError, formatPaise, MAX_SHARES, parseRupees, PERCENT_SCALE, type SplitMethod } from '@hisaab/money';
import type { Expense, ExpenseInput } from './api';

/** What the add/edit form holds: raw text as typed, per member where relevant. */
export type Draft = {
  description: string;
  occurredOn: string;
  amount: string;
  payerMode: 'single' | 'multiple';
  payer: string;
  payerAmounts: Record<string, string>;
  method: SplitMethod;
  /** equal: who shares it */
  included: Record<string, boolean>;
  /** exact: rupee amounts; percent: percentages; shares: whole numbers. Empty = not sharing. */
  values: Record<SplitMethod, Record<string, string>>;
};

export type FieldError = { field: string; message: string };
export type PreviewRow = { memberId: string; paidMinor: number; owedMinor: number };
export type Evaluation = {
  totalMinor: number | null;
  errors: FieldError[];
  /** One line about what is left to assign, when it applies. */
  remaining: string | null;
  /** Per member: what they paid and what their share is. Empty until the split can be computed. */
  preview: PreviewRow[];
  /** The exact request body, only when there are no errors. */
  input: ExpenseInput | null;
};

export function emptyDraft(memberIds: string[], me: string, today: string): Draft {
  return {
    description: '',
    occurredOn: today,
    amount: '',
    payerMode: 'single',
    payer: me,
    payerAmounts: {},
    method: 'equal',
    included: Object.fromEntries(memberIds.map((id) => [id, true])),
    values: { equal: {}, exact: {}, percent: {}, shares: {} },
  };
}

/** Rebuilds the form from a stored expense (for editing and for showing a conflict). */
export function draftFromExpense(e: Expense, memberIds: string[]): Draft {
  const payers = e.lines.filter((l) => l.paidMinor > 0);
  const single = payers.length === 1;
  // "1,234.50": what a person would type; parseRupees reads it back exactly.
  const rupees = (paise: number) => formatPaise(paise).replace(/^₹/, '');
  const values: Draft['values'] = { equal: {}, exact: {}, percent: {}, shares: {} };
  for (const l of e.lines) {
    if (l.weight === null) continue;
    if (e.splitMethod === 'exact') values.exact[l.memberId] = rupees(l.owedMinor);
    if (e.splitMethod === 'percent') values.percent[l.memberId] = formatBasisPoints(l.weight, false);
    if (e.splitMethod === 'shares') values.shares[l.memberId] = String(l.weight);
  }
  return {
    description: e.description,
    occurredOn: e.occurredOn,
    amount: rupees(e.totalMinor),
    payerMode: single ? 'single' : 'multiple',
    payer: single ? (payers[0]?.memberId ?? '') : '',
    payerAmounts: single ? {} : Object.fromEntries(payers.map((p) => [p.memberId, rupees(p.paidMinor)])),
    method: e.splitMethod,
    included: Object.fromEntries(memberIds.map((id) => [id, e.lines.some((l) => l.memberId === id && l.weight !== null)])),
    values,
  };
}

/** "33.33" or "33.33%" -> 3333 basis points, by string parsing. */
export function parsePercent(text: string): { ok: true; bp: number } | { ok: false; error: string } {
  const s = text.trim().replace(/%$/, '').trim();
  if (s === '') return { ok: true, bp: 0 };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, error: `“${text}” isn’t a percentage, like 33.33` };
  const frac = m[2] ?? '';
  if (frac.length > 2) return { ok: false, error: 'Use at most 2 decimal places for percentages' };
  const bp = Number(m[1] || '0') * 100 + Number(frac.padEnd(2, '0'));
  if (bp > PERCENT_SCALE) return { ok: false, error: 'A percentage can’t be over 100' };
  return { ok: true, bp };
}

export function formatBasisPoints(bp: number, withSign = true): string {
  const s = `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
  return withSign ? `${s}%` : s;
}

/**
 * Validates the draft and computes everyone's share with the same allocate() and the same seed
 * (the expense id) the server uses, so the preview is exactly what will be recorded.
 */
export function evaluateDraft(draft: Draft, memberIds: string[], seed: string): Evaluation {
  const errors: FieldError[] = [];
  let remaining: string | null = null;

  if (draft.description.trim() === '') errors.push({ field: 'description', message: 'Say what it was for, like “Dinner”' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.occurredOn)) errors.push({ field: 'occurredOn', message: 'Pick the date it happened' });

  let totalMinor: number | null = null;
  const total = parseRupees(draft.amount);
  if (!total.ok) errors.push({ field: 'amount', message: total.error });
  else if (total.paise === 0) errors.push({ field: 'amount', message: 'Enter an amount above ₹0.00' });
  else totalMinor = total.paise;

  // Who paid.
  let payers: { memberId: string; paidMinor: number }[] | null = null;
  if (draft.payerMode === 'single') {
    if (!memberIds.includes(draft.payer)) errors.push({ field: 'payers', message: 'Choose who paid' });
    else if (totalMinor !== null) payers = [{ memberId: draft.payer, paidMinor: totalMinor }];
  } else {
    const list: { memberId: string; paidMinor: number }[] = [];
    let bad = false;
    for (const id of memberIds) {
      const text = draft.payerAmounts[id] ?? '';
      if (text.trim() === '') continue;
      const p = parseRupees(text);
      if (!p.ok) {
        errors.push({ field: `paid:${id}`, message: p.error });
        bad = true;
      } else if (p.paise > 0) list.push({ memberId: id, paidMinor: p.paise });
    }
    if (!bad) {
      const paid = list.reduce((s, p) => s + p.paidMinor, 0);
      if (list.length === 0) errors.push({ field: 'payers', message: 'Enter what each person paid' });
      else if (totalMinor !== null && paid !== totalMinor) {
        errors.push({
          field: 'payers',
          message: paid < totalMinor
            ? `${formatPaise(totalMinor - paid)} of the total isn’t paid by anyone yet`
            : `Payers add up to ${formatPaise(paid - totalMinor)} more than the total`,
        });
      } else if (totalMinor !== null) payers = list;
    }
  }

  // How it is split.
  let weights: { memberId: string; weight: number }[] | null = null;
  const vals = draft.values[draft.method];
  if (draft.method === 'equal') {
    weights = memberIds.filter((id) => draft.included[id]).map((memberId) => ({ memberId, weight: 1 }));
    if (weights.length === 0) {
      errors.push({ field: 'split', message: 'Choose at least one person to share it' });
      weights = null;
    }
  } else {
    const list: { memberId: string; weight: number }[] = [];
    let bad = false;
    for (const id of memberIds) {
      const text = (vals[id] ?? '').trim();
      if (text === '') continue;
      let weight: number;
      if (draft.method === 'exact') {
        const p = parseRupees(text);
        if (!p.ok) {
          errors.push({ field: `split:${id}`, message: p.error });
          bad = true;
          continue;
        }
        weight = p.paise;
      } else if (draft.method === 'percent') {
        const p = parsePercent(text);
        if (!p.ok) {
          errors.push({ field: `split:${id}`, message: p.error });
          bad = true;
          continue;
        }
        weight = p.bp;
      } else {
        if (!/^\d+$/.test(text) || Number(text) > MAX_SHARES) {
          errors.push({ field: `split:${id}`, message: 'Shares are whole numbers, like 1 or 2' });
          bad = true;
          continue;
        }
        weight = Number(text);
      }
      if (weight > 0) list.push({ memberId: id, weight });
    }
    if (!bad) {
      const sum = list.reduce((s, w) => s + w.weight, 0);
      if (list.length === 0) {
        errors.push({ field: 'split', message: 'Give at least one person a share' });
      } else if (draft.method === 'exact' && totalMinor !== null && sum !== totalMinor) {
        remaining = sum < totalMinor ? `${formatPaise(totalMinor - sum)} left to assign` : `${formatPaise(sum - totalMinor)} over the total`;
        errors.push({ field: 'split', message: remaining });
      } else if (draft.method === 'percent' && sum !== PERCENT_SCALE) {
        remaining = sum < PERCENT_SCALE
          ? `${formatBasisPoints(PERCENT_SCALE - sum)} left to assign`
          : `${formatBasisPoints(sum - PERCENT_SCALE)} over 100%`;
        errors.push({ field: 'split', message: remaining });
      } else {
        weights = list;
      }
    }
  }

  // Preview whenever the split itself is computable, even if other fields still need work.
  let preview: PreviewRow[] = [];
  let owed: Map<string, number> | null = null;
  if (totalMinor !== null && weights !== null) {
    try {
      owed = new Map(allocate(totalMinor, draft.method, weights, seed).map((a) => [a.memberId, a.owedMinor]));
    } catch (err) {
      if (!(err instanceof AllocationError)) throw err;
      errors.push({ field: 'split', message: err.message });
    }
  }
  if (owed !== null) {
    const paid = new Map((payers ?? []).map((p) => [p.memberId, p.paidMinor]));
    preview = memberIds.map((memberId) => ({ memberId, paidMinor: paid.get(memberId) ?? 0, owedMinor: owed.get(memberId) ?? 0 }));
  }

  const input: ExpenseInput | null =
    errors.length === 0 && totalMinor !== null && payers !== null && weights !== null
      ? {
          description: draft.description.trim(),
          occurredOn: draft.occurredOn,
          totalMinor,
          payers,
          split: { method: draft.method, weights },
        }
      : null;
  return { totalMinor, errors, remaining, preview, input };
}
