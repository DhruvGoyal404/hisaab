import { allocate } from '@hisaab/money';
import { describe, expect, it } from 'vitest';
import type { Expense } from './api';
import { draftFromExpense, emptyDraft, evaluateDraft, parsePercent, type Draft } from './expenseDraft';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const ids = [A, B, C];
const SEED = '11111111-1111-4111-8111-111111111111';

const base = (patch: Partial<Draft> = {}): Draft => ({ ...emptyDraft(ids, A, '2026-10-18'), description: 'Dinner', amount: '100', ...patch });
const messages = (d: Draft) => evaluateDraft(d, ids, SEED).errors.map((e) => e.message);

describe('evaluateDraft', () => {
  it('builds the request body and a preview identical to allocate() with the same seed', () => {
    const r = evaluateDraft(base(), ids, SEED);
    expect(r.errors).toEqual([]);
    expect(r.input).toEqual({
      description: 'Dinner', occurredOn: '2026-10-18', totalMinor: 10000,
      payers: [{ memberId: A, paidMinor: 10000 }],
      split: { method: 'equal', weights: ids.map((memberId) => ({ memberId, weight: 1 })) },
    });
    const server = allocate(10000, 'equal', ids.map((memberId) => ({ memberId, weight: 1 })), SEED);
    expect(r.preview.map((p) => p.owedMinor)).toEqual(ids.map((id) => server.find((s) => s.memberId === id)?.owedMinor));
    expect(r.preview.reduce((s, p) => s + p.owedMinor, 0)).toBe(10000);
    expect(r.preview.find((p) => p.memberId === A)?.paidMinor).toBe(10000);
  });

  it('says exactly what is left to assign in an exact split', () => {
    const d = base({ method: 'exact', values: { equal: {}, exact: { [A]: '40', [B]: '57' }, percent: {}, shares: {} } });
    const r = evaluateDraft(d, ids, SEED);
    expect(r.remaining).toBe('₹3.00 left to assign');
    expect(r.input).toBeNull();
    expect(messages({ ...d, values: { ...d.values, exact: { [A]: '60', [B]: '45' } } })).toContain('₹5.00 over the total');
  });

  it('says how much percentage is missing or over', () => {
    const d = base({ method: 'percent', values: { equal: {}, exact: {}, percent: { [A]: '33.33', [B]: '33.33' }, shares: {} } });
    expect(evaluateDraft(d, ids, SEED).remaining).toBe('33.34% left to assign');
    expect(messages({ ...d, values: { ...d.values, percent: { [A]: '60', [B]: '50' } } })).toContain('10.00% over 100%');
    const ok = evaluateDraft({ ...d, values: { ...d.values, percent: { [A]: '33.33', [B]: '33.33', [C]: '33.34' } } }, ids, SEED);
    expect(ok.preview.map((p) => p.owedMinor)).toEqual([3333, 3333, 3334]);
  });

  it('checks multiple payers against the total', () => {
    const d = base({ payerMode: 'multiple', payerAmounts: { [A]: '60', [B]: '30' } });
    expect(messages(d)).toContain('₹10.00 of the total isn’t paid by anyone yet');
    expect(messages({ ...d, payerAmounts: { [A]: '60', [B]: '50' } })).toContain('Payers add up to ₹10.00 more than the total');
    expect(evaluateDraft({ ...d, payerAmounts: { [A]: '60', [B]: '40' } }, ids, SEED).input?.payers).toEqual([
      { memberId: A, paidMinor: 6000 }, { memberId: B, paidMinor: 4000 },
    ]);
  });

  it('reports bad amounts, shares and empty selections in plain words', () => {
    expect(messages(base({ amount: '12.345' }))).toContain('Use at most 2 decimal places (paise)');
    expect(messages(base({ amount: '0' }))).toContain('Enter an amount above ₹0.00');
    expect(messages(base({ description: '  ' }))).toContain('Say what it was for, like “Dinner”');
    expect(messages(base({ included: { [A]: false, [B]: false, [C]: false } }))).toContain('Choose at least one person to share it');
    expect(messages(base({ method: 'shares', values: { equal: {}, exact: {}, percent: {}, shares: { [A]: '1.5' } } })))
      .toContain('Shares are whole numbers, like 1 or 2');
  });

  it('still previews the split while unrelated fields are incomplete', () => {
    const r = evaluateDraft(base({ description: '' }), ids, SEED);
    expect(r.input).toBeNull();
    expect(r.preview).toHaveLength(3);
  });
});

describe('draftFromExpense', () => {
  it('round-trips a stored percent expense back to the same request', () => {
    const stored: Expense = {
      expenseId: SEED, version: 2, deleted: false, description: 'Cab', occurredOn: '2026-10-17', totalMinor: 123456,
      splitMethod: 'percent',
      lines: [
        { memberId: A, paidMinor: 100000, owedMinor: 41148, weight: 3333 },
        { memberId: B, paidMinor: 23456, owedMinor: 41148, weight: 3333 },
        { memberId: C, paidMinor: 0, owedMinor: 41160, weight: 3334 },
      ],
    };
    const r = evaluateDraft(draftFromExpense(stored, ids), ids, SEED);
    expect(r.errors).toEqual([]);
    expect(r.input).toMatchObject({ totalMinor: 123456, payers: [{ memberId: A, paidMinor: 100000 }, { memberId: B, paidMinor: 23456 }] });
    expect(r.input?.split.weights.map((w) => w.weight)).toEqual([3333, 3333, 3334]);
  });
});

describe('parsePercent', () => {
  it.each([['33.33', 3333], ['33.33%', 3333], ['100', 10000], ['.5', 50], ['', 0]])('%j -> %i bp', (t, bp) => {
    expect(parsePercent(t)).toEqual({ ok: true, bp });
  });
  it.each(['33.333', '101', 'abc', '-5'])('rejects %j', (t) => {
    expect(parsePercent(t).ok).toBe(false);
  });
});
