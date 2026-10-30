// CI's audit gate: `npm audit --audit-level=high`, except for the dated exceptions below. Fails on
// any high or critical advisory not listed, on any exception past its date, and if audit gives no
// report. Run: node scripts/audit-gate.mjs [saved-audit.json]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EXCEPTIONS = [
  // body-parser 2.4.0 fixes this but is under the 14-day rule until this date. Not reachable:
  // api/src/app.ts sets inflate: false, and api/test/app.test.ts proves it. On expiry, upgrade.
  { url: 'https://github.com/advisories/GHSA-27r3-jxmh-p828', until: '2026-11-05' },
];

const file = process.argv[2];
const raw = file
  ? readFileSync(file, 'utf8')
  : spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 2 ** 26 }).stdout;

let report;
try {
  report = JSON.parse(raw);
} catch {
  report = undefined;
}
if (!report?.metadata?.vulnerabilities) {
  console.error('FAIL: npm audit gave no report');
  process.exit(1);
}

const today = process.env.AUDIT_GATE_TODAY ?? new Date().toISOString().slice(0, 10);
const advisories = new Map();
for (const { via } of Object.values(report.vulnerabilities ?? {})) {
  // A string in `via` names another vulnerable package, which has its own entry.
  for (const v of via) {
    if (typeof v === 'object' && (v.severity === 'high' || v.severity === 'critical')) advisories.set(v.url, v);
  }
}

let failed = false;
for (const [url, v] of advisories) {
  const exception = EXCEPTIONS.find((e) => e.url === url);
  if (exception && today < exception.until) {
    console.log(`excepted until ${exception.until}: ${v.name} ${url}`);
  } else {
    console.error(`FAIL: ${v.severity} ${v.name} ${url}${exception ? ` (exception ended ${exception.until})` : ''}`);
    failed = true;
  }
}
console.log(failed ? 'audit gate: FAILED' : `audit gate: passed, ${advisories.size} high or critical (all excepted)`);
process.exit(failed ? 1 : 0);
