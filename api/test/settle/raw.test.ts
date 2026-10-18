import { describe, expect, it } from 'vitest';
import { rawDebts, type RawExpense } from '../../src/settle/raw.js';
import { SettleError } from '../../src/settle/types.js';

const line = (memberId: string, paidMinor: number, owedMinor: number) => ({ memberId, paidMinor, owedMinor });

describe('rawDebts', () => {
  it('each participant owes the single payer their share', () => {
    const e: RawExpense = { expenseId: 'e1', lines: [line('asha', 900, 300), line('bilal', 0, 300), line('chirag', 0, 300)] };
    expect(rawDebts([e], [])).toEqual([
      { from: 'bilal', to: 'asha', amountMinor: 300 },
      { from: 'chirag', to: 'asha', amountMinor: 300 },
    ]);
  });

  it('nets debts in both directions per pair', () => {
    const a: RawExpense = { expenseId: 'e1', lines: [line('asha', 1000, 500), line('bilal', 0, 500)] };
    const b: RawExpense = { expenseId: 'e2', lines: [line('bilal', 600, 300), line('asha', 0, 300)] };
    expect(rawDebts([a, b], [])).toEqual([{ from: 'bilal', to: 'asha', amountMinor: 200 }]);
  });

  it('does not simplify through a third person', () => {
    // Asha is owed by Bilal, who is owed by Chirag: raw keeps two debts (simplified would be one).
    const a: RawExpense = { expenseId: 'e1', lines: [line('asha', 100, 0), line('bilal', 0, 100)] };
    const b: RawExpense = { expenseId: 'e2', lines: [line('bilal', 100, 0), line('chirag', 0, 100)] };
    expect(rawDebts([a, b], [])).toHaveLength(2);
  });

  it('splits a participant across several payers with both margins exact', () => {
    // Asha paid 600, Bilal 401 of 1001; split equally between Chirag, Dev and Esha (334/334/333).
    const e: RawExpense = {
      expenseId: 'e1',
      lines: [line('asha', 600, 0), line('bilal', 401, 0), line('chirag', 0, 334), line('dev', 0, 334), line('esha', 0, 333)],
    };
    const t = rawDebts([e], []);
    const toPayer = (p: string) => t.filter((x) => x.to === p).reduce((s, x) => s + x.amountMinor, 0);
    const fromParticipant = (p: string) => t.filter((x) => x.from === p).reduce((s, x) => s + x.amountMinor, 0);
    expect([toPayer('asha'), toPayer('bilal')]).toEqual([600, 401]);
    expect([fromParticipant('chirag'), fromParticipant('dev'), fromParticipant('esha')]).toEqual([334, 334, 333]);
  });

  it('applies settlements to the pair they were between', () => {
    const e: RawExpense = { expenseId: 'e1', lines: [line('asha', 1000, 500), line('bilal', 0, 500)] };
    expect(rawDebts([e], [{ from: 'bilal', to: 'asha', amountMinor: 200 }])).toEqual([{ from: 'bilal', to: 'asha', amountMinor: 300 }]);
    expect(rawDebts([e], [{ from: 'bilal', to: 'asha', amountMinor: 500 }])).toEqual([]);
    expect(rawDebts([e], [{ from: 'bilal', to: 'asha', amountMinor: 700 }])).toEqual([{ from: 'asha', to: 'bilal', amountMinor: 200 }]);
  });

  it('rejects an expense whose paid and owed differ', () => {
    expect(() => rawDebts([{ expenseId: 'x', lines: [line('a', 10, 9)] }], [])).toThrow(SettleError);
  });
});
