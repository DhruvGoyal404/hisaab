// The production-stack smoke workload (deploy/smoke/smoke.sh runs it; it is also the load the
// memory budget is measured under). Production refuses the dev sign-in, so sessions are seeded
// straight into Postgres by the owner, the same way the API stores them: only the SHA-256 hash.
//
//   node deploy/smoke/workload.mjs seed <tokens.json>   prints seed SQL, writes the raw tokens
//   node deploy/smoke/workload.mjs run  <tokens.json>   drives the stack, exits non-zero on failure
//
// Environment: API_BASE (https://hisaab.dhruvgoyal.tech through the edge, or the API's loopback
// port without it) and ORIGIN (the allowed web origin, default https://hisaab.dhruvgoyal.tech).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';

const USERS = ['Smoke Asha', 'Smoke Bilal', 'Smoke Chen', 'Smoke Dana'];
const TABS_PER_USER = 2;
// 25 each stays under the per-user limit (60 expenses per 10 minutes), so nothing here is a 429.
const EXPENSES_PER_USER = 25;

const [mode, tokensFile] = process.argv.slice(2);
if (!tokensFile || (mode !== 'seed' && mode !== 'run')) {
  console.error('usage: workload.mjs seed|run <tokens.json>');
  process.exit(2);
}

if (mode === 'seed') {
  const tokens = {};
  const rows = USERS.map((name) => {
    const token = randomBytes(32).toString('base64url');
    tokens[name] = token;
    const hash = createHash('sha256').update(token).digest('hex');
    return `WITH u AS (INSERT INTO users (display_name) VALUES ('${name}') RETURNING id)
INSERT INTO sessions (user_id, token_hash, expires_at) SELECT id, decode('${hash}', 'hex'), now() + interval '1 hour' FROM u;`;
  });
  writeFileSync(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
  console.log(['BEGIN;', ...rows, 'COMMIT;'].join('\n'));
  process.exit(0);
}

const API = process.env.API_BASE ?? 'https://hisaab.dhruvgoyal.tech';
const ORIGIN = process.env.ORIGIN ?? 'https://hisaab.dhruvgoyal.tech';
const tokens = JSON.parse(readFileSync(tokensFile, 'utf8'));
const cookie = (name) => `hisaab_session=${tokens[name]}`;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};
const ms = (t0) => `${Math.round(performance.now() - t0)} ms`;

async function call(name, method, path, body, headers = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      ...(name && { cookie: cookie(name) }),
      origin: ORIGIN,
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json };
}

async function until(cond, ms_, what) {
  const end = Date.now() + ms_;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const [asha, ...others] = USERS;

// --- Production refusals
check((await call(undefined, 'POST', '/dev/login', { name: 'intruder' })).status === 404, 'dev sign-in does not exist (404)');
const foreign = await fetch(`${API}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } });
check(foreign.status === 403, `a POST from a foreign Origin is refused (${foreign.status})`);
check((await call(undefined, 'GET', '/me')).status === 401, 'no session: 401');
for (const name of USERS) {
  const me = await call(name, 'GET', '/me');
  check(me.status === 200 && me.json?.user?.name === name, `${name} signed in through a seeded session`);
}

// --- A group of four, joined through invite links
let t0 = performance.now();
const { json: group } = await call(asha, 'POST', '/groups', { name: 'Smoke trip' });
const members = { [asha]: group.memberId };
for (const name of others) {
  const { json: invite } = await call(asha, 'POST', `/groups/${group.groupId}/invites`, {});
  const accepted = await call(name, 'POST', `/invites/${invite.token}/accept`);
  members[name] = accepted.json?.memberId;
}
check(Object.values(members).every(Boolean), `group made and joined by all four (${ms(t0)})`);

// --- Sockets: two tabs per user, each must see every change exactly once
const anonymous = await new Promise((resolve) => {
  const s = io(API, { path: '/api/socket.io', transports: ['websocket'], extraHeaders: { origin: ORIGIN }, reconnection: false });
  s.on('connect_error', (e) => { s.close(); resolve(e.message); });
  s.on('ready', () => { s.close(); resolve('connected'); });
});
check(anonymous === 'unauthenticated', `a socket without a session is refused (${anonymous})`);

const tabs = [];
for (const name of USERS) {
  for (let i = 0; i < TABS_PER_USER; i++) {
    const seen = new Set();
    const s = io(API, { path: '/api/socket.io', transports: ['websocket'], extraHeaders: { cookie: cookie(name), origin: ORIGIN }, reconnection: false });
    s.on('group:changed', ({ groupId, seq }) => { if (groupId === group.groupId) seen.add(seq); });
    await new Promise((resolve, reject) => {
      s.once('ready', ({ groups }) => (groups.includes(group.groupId) ? resolve() : reject(new Error(`${name} not in the group's room`))));
      s.once('connect_error', reject);
    });
    s.emit('sync', {});
    tabs.push({ name, s, seen });
  }
}
check(tabs.length === USERS.length * TABS_PER_USER, `${tabs.length} sockets connected, each in the group's room`);

// --- Expenses from everyone at once, equal split among all four
t0 = performance.now();
const all = Object.values(members);
let sent = 0;
await Promise.all(USERS.map(async (name) => {
  for (let i = 0; i < EXPENSES_PER_USER; i++) {
    const totalMinor = 10_000 + Math.floor(Math.random() * 90_000) + 1; // ₹100 to ₹1,000 and odd paise
    const r = await call(name, 'POST', `/groups/${group.groupId}/expenses`, {
      description: `Smoke ${i}`, occurredOn: '2026-10-30', totalMinor,
      payers: [{ memberId: members[name], paidMinor: totalMinor }],
      split: { method: 'equal', weights: all.map((memberId) => ({ memberId, weight: 1 })) },
    }, { 'idempotency-key': randomUUID() });
    if (r.status === 201) sent += 1;
    else console.log(`     expense refused: ${r.status} ${JSON.stringify(r.json)}`);
  }
}));
check(sent === USERS.length * EXPENSES_PER_USER, `${sent} expenses recorded (${ms(t0)})`);

const { json: feed } = await call(asha, 'GET', `/groups/${group.groupId}/activity?limit=1`);
const lastSeq = feed.items[0].seq;
t0 = performance.now();
try {
  await until(() => tabs.every((t) => t.seen.has(lastSeq)), 30_000, 'every socket sees the last change');
  check(true, `every socket saw seq ${lastSeq} live (${ms(t0)} after the last write)`);
} catch (e) {
  check(false, `${e.message}: ${tabs.map((t) => t.seen.size).join(',')}`);
}

// --- Balances add up; settling the plan brings everyone to zero
const balances = async () => (await call(asha, 'GET', `/groups/${group.groupId}/balances`)).json.members;
const before = await balances();
check(before.reduce((s, m) => s + m.balanceMinor, 0) === 0, `balances sum to zero (${before.map((m) => m.balanceMinor).join(', ')})`);
const nameOf = Object.fromEntries(Object.entries(members).map(([n, id]) => [id, n]));
const { json: plan } = await call(asha, 'GET', `/groups/${group.groupId}/settle-plan`);
check(plan.transfers.length <= USERS.length - 1, `the plan settles in ${plan.transfers.length} payments (at most n-1)`);
for (const t of plan.transfers) {
  const r = await call(nameOf[t.from], 'POST', `/groups/${group.groupId}/settlements`,
    { fromMemberId: t.from, toMemberId: t.to, amountMinor: t.amountMinor }, { 'idempotency-key': randomUUID() });
  check(r.status === 201, `${nameOf[t.from]} pays ${nameOf[t.to]} ${t.amountMinor} paise`);
}
const after = await balances();
check(after.every((m) => m.balanceMinor === 0), 'after settling, every balance is zero');

// --- A history read, then done
const page = await call(asha, 'GET', `/groups/${group.groupId}/activity?limit=50`);
check(page.status === 200 && page.json.items.length === 50, 'the activity feed reads a full page');
for (const t of tabs) t.s.close();

console.log(failures === 0 ? 'workload: all checks passed' : `workload: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
