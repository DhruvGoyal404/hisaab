import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_TOTAL_MINOR } from '../src/allocate.js';
import { formatPaise, paiseToDecimal, parseRupees } from '../src/money.js';
import { runs } from './fc.js';

const ok = (paise: number) => ({ ok: true, paise });

describe('parseRupees: accepted input', () => {
  it.each([
    ['0', 0],
    ['0.07', 7],
    ['.5', 50],
    ['5.', 500],
    ['99', 9900],
    ['₹99', 9900],
    ['₹ 99', 9900],
    ['Rs 12', 1200],
    ['rs.12.50', 1250],
    ['INR 3', 300],
    ['1,234.5', 123450],
    ['12,34,567.89', 123456789], // Indian grouping
    ['1,234,567.89', 123456789], // Western grouping
    ['  42.10  ', 4210],
    ['007', 700],
    ['0.1', 10],
    ['19.99', 1999], // 19.99 * 100 is 1998.9999999999998 in floating point
    ['1.15', 115], //  1.15 * 100 is 114.99999999999999
    ['100000000', 10_000_000_000],
    ['1,00,00,00,000', MAX_TOTAL_MINOR],
    ['1000000000.00', MAX_TOTAL_MINOR],
  ])('%j -> %i paise', (input, paise) => {
    expect(parseRupees(input)).toEqual(ok(paise));
  });
});

describe('parseRupees: rejected input, with a message that says what to fix', () => {
  it.each([
    ['', 'Enter an amount'],
    ['   ', 'Enter an amount'],
    ['₹', 'Enter an amount after the ₹ sign'],
    ['.', 'Enter an amount'],
    ['-5', 'can’t be negative'],
    ['₹-5', 'can’t be negative'],
    ['1.005', 'at most 2 decimal places'],
    ['0.001', 'at most 2 decimal places'],
    ['1.2.3', 'more than one decimal point'],
    ['abc', 'isn’t an amount'],
    ['12a', 'isn’t an amount'],
    ['1e5', 'isn’t an amount'],
    ['0x10', 'isn’t an amount'],
    ['1 234', 'isn’t an amount'],
    ['1,23', 'Check the commas'],
    ['1,2345', 'Check the commas'],
    [',123', 'Check the commas'],
    ['1,234.5,6', 'isn’t an amount'],
    ['1000000000.01', 'The most one amount can be is ₹1,00,00,00,000.00'],
    ['99999999999', 'The most one amount can be is'],
  ])('%j', (input, message) => {
    const r = parseRupees(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe('formatPaise', () => {
  it.each([
    [0, '₹0.00'],
    [7, '₹0.07'],
    [50, '₹0.50'],
    [123450, '₹1,234.50'],
    [123456789, '₹12,34,567.89'],
    [MAX_TOTAL_MINOR, '₹1,00,00,00,000.00'],
    [-500, '-₹5.00'],
  ])('%i -> %s', (paise, text) => {
    expect(formatPaise(paise)).toBe(text);
  });

  it('builds exact decimal strings', () => {
    expect([0, 7, 70, 700, -7, 123456].map(paiseToDecimal)).toEqual(['0.00', '0.07', '0.70', '7.00', '-0.07', '1234.56']);
    expect(() => paiseToDecimal(0.5)).toThrow(RangeError);
  });
});

describe('properties', () => {
  const paise = fc.oneof(fc.constantFrom(0, 1, 99, 100, MAX_TOTAL_MINOR), fc.integer({ min: 0, max: MAX_TOTAL_MINOR }));

  it('format -> parse round-trips every amount from 0 to the cap', () => {
    fc.assert(fc.property(paise, (p) => {
      expect(parseRupees(formatPaise(p))).toEqual(ok(p));
    }), runs(20_000));
  });

  it('plain decimal strings parse to the exact paise', () => {
    fc.assert(fc.property(paise, (p) => {
      expect(parseRupees(paiseToDecimal(p))).toEqual(ok(p));
    }), runs(20_000));
  });

  it('never throws, and anything accepted is an integer in range', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 20 }), (s) => {
      const r = parseRupees(s);
      if (r.ok) expect(Number.isSafeInteger(r.paise) && r.paise >= 0 && r.paise <= MAX_TOTAL_MINOR).toBe(true);
    }), runs(20_000));
  });

  it('accepts digit strings with commas, grouping-checked, the same as without', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 999_999_999 }), fc.boolean(), (rupees, indian) => {
      const grouped = new Intl.NumberFormat(indian ? 'en-IN' : 'en-US').format(rupees);
      expect(parseRupees(grouped)).toEqual(parseRupees(String(rupees)));
    }), runs(5_000));
  });
});
