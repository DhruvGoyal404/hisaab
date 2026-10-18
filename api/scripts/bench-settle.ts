// Benchmarks exact settlement at the worst case for each k (no zero-sum subsets, so nothing is
// pruned; the DP does all 2^k · k steps) plus greedy at large k. Informational; run with
//   npm run bench:settle -w api
// Output is a markdown table so it can be pasted into docs/ALGORITHMS.md.
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { exactSettle } from '../src/settle/exact.js';
import { greedySettle } from '../src/settle/greedy.js';
import type { Balance } from '../src/settle/types.js';

/** Deterministic pseudo-random generator (mulberry32), so every run benchmarks the same input. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k balances summing to zero; large random magnitudes make zero-sum proper subsets vanishingly unlikely. */
function worstCase(k: number, seed = 42): Balance[] {
  const next = rng(seed + k);
  const values = Array.from({ length: k - 1 }, (_, i) => Math.floor(1e6 + next() * 1e9) * (i % 2 === 0 ? 1 : -1));
  values.push(-values.reduce((s, v) => s + v, 0));
  return values.map((balanceMinor, i) => ({ memberId: `m${String(i).padStart(3, '0')}`, balanceMinor }));
}

function time(fn: () => unknown, iterations: number): { median: number; p95: number; max: number } {
  for (let i = 0; i < 3; i++) fn(); // warm up the JIT
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? NaN;
  return { median: at(0.5), p95: at(0.95), max: samples.at(-1) ?? NaN };
}

const fmt = (ms: number) => ms.toFixed(1);
const rows: string[] = [];
for (const k of [12, 14, 16, 17, 18, 19, 20]) {
  const input = worstCase(k);
  // Past MAX_EXACT_MEMBERS on purpose: the table shows why the cap is where it is.
  const transfers = exactSettle(input, 20).length;
  const t = time(() => exactSettle(input, 20), k <= 18 ? 30 : 10);
  rows.push(`| exact | ${k} | ${fmt(t.median)} | ${fmt(t.p95)} | ${fmt(t.max)} | ${transfers} |`);
}
for (const k of [100, 1000]) {
  const input = worstCase(k);
  const t = time(() => greedySettle(input), 30);
  rows.push(`| greedy | ${k} | ${fmt(t.median)} | ${fmt(t.p95)} | ${fmt(t.max)} | ${greedySettle(input).length} |`);
}

const cpu = cpus()[0]?.model ?? 'unknown CPU';
process.stdout.write(
  `Node ${process.version}, ${cpu}${process.env.CI ? ' (CI)' : ''}\n\n` +
    '| algorithm | k | median ms | p95 ms | max ms | transfers |\n|---|---|---|---|---|---|\n' +
    `${rows.join('\n')}\n`,
);
