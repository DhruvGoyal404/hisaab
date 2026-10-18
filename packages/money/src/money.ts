import { MAX_TOTAL_MINOR } from './allocate.js';

export type ParseResult = { ok: true; paise: number } | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });

// Commas are thousands separators, Western (1,234,567) or Indian (12,34,567) grouping.
const WESTERN_GROUPS = /^\d{1,3}(,\d{3})+$/;
const INDIAN_GROUPS = /^\d{1,2}(,\d{2})*,\d{3}$/;

/**
 * Parses what a person types ("1,234.5", "₹99", "Rs. 12", "0.07", ".5") into integer paise by
 * string manipulation alone: no parseFloat, so "0.07" is exactly 7 paise and never 6.999…
 * Errors say exactly what to fix. Zero parses (forms decide whether zero is allowed).
 */
export function parseRupees(input: string): ParseResult {
  const raw = input.trim();
  if (raw === '') return fail('Enter an amount');
  const s = raw.replace(/^(₹|rs\.?|inr)\s*/i, '');
  if (s.startsWith('-')) return fail('Amounts can’t be negative');
  if (s === '') return fail('Enter an amount after the ₹ sign');

  const parts = s.split('.');
  if (parts.length > 2) return fail(`“${raw}” has more than one decimal point`);
  const [intRaw = '', frac = ''] = parts;
  if (!/^[\d,]*$/.test(intRaw) || !/^\d*$/.test(frac)) {
    return fail(`“${raw}” isn’t an amount. Use digits, like 1,234.50`);
  }
  if (intRaw === '' && frac === '') return fail('Enter an amount');
  if (intRaw.includes(',') && !WESTERN_GROUPS.test(intRaw) && !INDIAN_GROUPS.test(intRaw)) {
    return fail(`Check the commas in “${raw}”`);
  }
  if (frac.length > 2) return fail('Use at most 2 decimal places (paise)');

  const paise = BigInt(intRaw.replaceAll(',', '') || '0') * 100n + BigInt(frac.padEnd(2, '0'));
  if (paise > BigInt(MAX_TOTAL_MINOR)) return fail(`The most one amount can be is ${formatPaise(MAX_TOTAL_MINOR)}`);
  return { ok: true, paise: Number(paise) };
}

/** Exact decimal rupee string for integer paise: 7 -> "0.07", -123456 -> "-1234.56". */
export function paiseToDecimal(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`paise must be a safe integer, got ${paise}`);
  const sign = paise < 0 ? '-' : '';
  const abs = String(Math.abs(paise)).padStart(3, '0');
  return `${sign}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * "₹1,23,456.78" with Indian lakh/crore grouping. The formatter is given an exact decimal string
 * (Intl.NumberFormat accepts those), so display involves no floating point either.
 */
export function formatPaise(paise: number): string {
  return INR.format(paiseToDecimal(paise) as Intl.StringNumericLiteral);
}
