# Hisaab: Audit of the legacy prototype (Step 1, read-only)

Audit date: 2026-10-17. Scope: everything in the project folder, excluding `node_modules`. Nothing was installed, run, or modified. The only other file read was `../INVENTORY.md`, and nothing in `../CodeEditor` was opened.

> **Status (2026-10-17):** the audited legacy code was archived as a dated legacy zip in `E:\Dhruv\_backups\` (verified: 11,348 files, identical SHA-1s) and deleted from the repo. File:line references below point into that archive. Decisions since the audit: PostgreSQL approved; auth is Google OIDC + GitHub sign-in (no magic link for now); the product is named Hisaab. The phase table in [CLAUDE.md](../CLAUDE.md) is the current plan.

**Verdict:** this is a ~25%-complete prototype (about 250 LOC of real code). It does not run end to end, it has no balance or split logic, and its security problems are critical by design. **I recommend a rewrite.** Almost nothing is worth keeping except the product idea.

---

## 1. Inventory and architecture as it actually is

### Files (17 non-generated files)

| Path | LOC | Role |
|---|---|---|
| `backend/server.js` | 102 | The whole backend: Express app, Mongo connection, auth middleware, all routes, Socket.IO |
| `backend/models/User.js` | 17 | User schema plus bcrypt pre-save hook |
| `backend/models/Room.js` | 17 | Room schema with an embedded `expenses` array |
| `backend/routes/auth.js` | 28 | **Dead code.** Duplicate register/login router, never mounted |
| `backend/routes/room.js` | 27 | **Dead code.** Duplicate create/join router, never mounted, trusts `userId` from the body |
| `backend/package.json`, `package-lock.json` | | Dependencies. No `start` script, and `test` is the npm placeholder |
| `frontend/src/main.jsx` | 10 | React root |
| `frontend/src/App.jsx` | 28 | Switches between `Auth` and `Room`+`Graph` on `roomId` state |
| `frontend/src/components/Auth.js` | 51 | Login/register form |
| `frontend/src/components/Room.js` | 62 | "Add expense" form plus live expense list |
| `frontend/src/components/Graph.js` | 26 | Debt graph via `react-d3-graph` (package not installed) |
| `frontend/vite.config.js`, `tailwind.config.js`, `postcss.config.js`, `eslint.config.js`, `index.html`, `App.css`, `index.css`, `README.md` | | Vite template boilerplate. `App.css` is unused |

There is no `.env`, Dockerfile, CI, or tests.

### Backend routes (all in `backend/server.js`)

| Method & path | Auth | What it does | Ref |
|---|---|---|---|
| `POST /register` | none | `new User({username,email,password}).save()` with no validation | `server.js:42-47` |
| `POST /login` | none | `User.findOne({email})` then `bcrypt.compare` and issues a JWT (1h) | `server.js:49-57` |
| `POST /room/create` | JWT | Creates a Room with a plaintext `password` and `users:[req.user.id]` | `server.js:59-64` |
| `POST /room/join` | JWT | Compares the plaintext room password, pushes the user (duplicates allowed), and **returns the full room including `password`** | `server.js:66-75` |
| `POST /room/expense` | JWT | Loads any room by id, pushes `{payer, amount, participants}` straight from the body, emits `expenseUpdate`, and **returns the full room including `password`** | `server.js:77-85` |

No route reads a room, lists rooms, computes balances, settles up, edits, or deletes anything.

Auth middleware (`server.js:28-39`): reads the raw `Authorization` header (no `Bearer` scheme) and calls `jwt.verify` with a hardcoded secret. An invalid token returns **400**, not 401.

### Models

- `User` (`models/User.js:5-9`): `username`, `email`, `password`, all untyped `String` with no `required`, `unique`, `lowercase`, or index. The password is hashed in a pre-save hook with bcrypt cost 10 (`User.js:11-15`).
- `Room` (`models/Room.js:4-15`): `name`, plaintext `password`, `users: [ObjectId]`, and embedded `expenses: [{ payer: ObjectId, amount: Number, participants: [ObjectId] }]`. There are no timestamps, no description, no split type, no currency, and no settlements.

### Socket.IO events (`server.js:87-97`)

| Direction | Event | Payload | Auth / scoping |
|---|---|---|---|
| client → server | `joinRoom` | `roomId` (any string) | **None.** Any socket can join any room name |
| server → room | `expenseUpdate` | the room's **entire** `expenses` array | Emitted to `roomId` taken from the HTTP body (`server.js:83`) |
| | `connection` / `disconnect` | | log only |

The Socket.IO server is created as `socketIo(server)` with no `cors` option (`server.js:12`). Since Socket.IO v3, cross-origin requests must be explicitly allowed. The Vite dev page (another origin) connects to `http://localhost:5000` (`Room.js:6`) using HTTP long-polling by default, so the browser should block the handshake. **Live updates very likely never worked in dev** (inferred from config, not run).

### Frontend

- `App.jsx:7-26`: shows `Auth` until `roomId` is set, then `Room` and `ExpenseGraph expenses={[]}` (always empty, `App.jsx:21`).
- `Auth.js:5`: the component takes **no props**, so `onJoinRoom` passed from `App.jsx:17` is never called. **The UI cannot get past the login screen.** There is no create-room or join-room UI anywhere.
- `Auth.js:13`: posts `{email, password}` only, so `username` is never set. On register the backend returns no token, so `localStorage.token` becomes the string `"undefined"` (`Auth.js:14`).
- `Room.js:27`: the expense POST is **hardcoded**: `payerId: 'user-id', amount: 50, participants: ['B','C','D']`. The text input is ignored. Those values are not valid ObjectIds, so Mongoose throws a CastError on save, which goes unhandled (see §3).
- `Room.js:6`: the socket is created at module import time, before any login, with no credentials.
- `Room.js:51-55`: renders raw ObjectIds as names. There is no initial fetch, so the list is empty until someone else posts.
- `Graph.js:3`: imports `react-d3-graph`, which is **not in `package.json` and not installed**. Vite will fail to resolve the import, and because `App.jsx:5` imports it, **the whole frontend fails to load.** The graph logic is also wrong: node ids `User0..n` are indices, but link endpoints use `User<payerObjectId>`, and only `participants[0]` is linked.

### Data flow: "create room → add expense → see balances"

1. **Create room:** possible only via the API (`curl POST /room/create` with the JWT). There is no UI.
2. **Join:** `POST /room/join` with `{roomId, password}`. There is no UI.
3. **Add expense:** `POST /room/expense` stores whatever the client sends (`server.js:78-82`), then broadcasts the expense array (`server.js:83`). The only UI path sends the hardcoded invalid payload.
4. **See balances:** **does not exist.** No code anywhere computes who owes whom: no split math, no net balance, and no simplification.

---

## 2. Stack and versions

Declared ranges with installed versions (read from `node_modules/*/package.json`). The local runtime is Node v22.19.0.

| Package | Declared | Installed | Notes |
|---|---|---|---|
| express | ^4.19.2 | 4.19.2 | Express 5 is now the default line. 4.19.2 predates fixes for several 2024 advisories in its own dependencies: `body-parser` 1.20.2 (DoS, fixed in 1.20.3), `path-to-regexp` 0.1.7 (ReDoS, fixed in 0.1.10/0.1.12), `send` 0.18.0 / `serve-static` 1.15.0 (template injection/XSS, fixed in 0.19/1.16), and `res.redirect` XSS (fixed in express 4.20) |
| mongoose | ^8.5.2 | 8.5.2 (driver 6.7.0) | 8.x had later fixes for `$where`/populate-match injection (8.8.3, 8.9.5). `useNewUrlParser`/`useUnifiedTopology` (`server.js:18-21`) are no-ops the driver flags as deprecated |
| socket.io | ^4.7.5 | 4.7.5 (engine.io 6.5.5, ws 8.17.1, cookie 0.6.0) | ws 8.17.1 already includes the DoS fix. engine.io < 6.6.2 pulls `cookie` < 0.7 (cookie-name injection advisory) |
| jsonwebtoken | ^9.0.2 | 9.0.2 | OK |
| bcryptjs | ^2.4.3 | 2.4.3 | Works. bcrypt truncates input at 72 bytes |
| cors | **not declared** | 2.8.5 | `require('cors')` (`server.js:8`) only works because socket.io depends on it and npm hoisted it |
| react / react-dom | ^18.3.1 | 18.3.1 | Fine, though React 19 is current |
| vite | ^5.4.0 | 5.4.0 | Several dev-server file-disclosure advisories were fixed in later 5.4.x patches |
| @vitejs/plugin-react | ^4.3.1 | 4.3.1 | **Installed but not used.** `vite.config.js:1-2` imports `defineConfig` and `react` but exports a plain object with no plugins |
| axios | ^1.7.3 | 1.7.3 | Later 1.x patches fixed SSRF/DoS advisories |
| socket.io-client | ^4.7.5 | 4.7.5 | |
| tailwindcss | ^3.4.9 | 3.4.9 | `tailwind.config.js` uses `module.exports` inside a `"type": "module"` package. Whether Tailwind's loader tolerates this is **unclear**; it is a risk |
| react-d3-graph | **not declared** | **not installed** | Unmaintained, and expects old React/d3 |
| eslint | ^9.8.0 | 9.9.0 | Lints `*.{js,jsx}`. Never run as far as I can tell |

The advisory notes come from my knowledge, not from `npm audit`, which I didn't run because this step is read-only. **Confirm with `npm audit` in Phase 1.**

Build oddity: the components are `.js` files that contain JSX. `vite.config.js:6-9` sets `esbuild.loader: 'jsx'` for `src/**/*.js`, but `optimizeDeps.esbuildOptions` is not set and the React plugin isn't applied. Whether `vite build` succeeds once `react-d3-graph` is fixed is **unclear** without running it.

---

## 3. What works vs. stubbed / broken / TODO

**Probably works (not executed):**
- Register and login over the API with well-formed input. Password hashing works.
- JWT issue and verify.
- Room create/join over the API (with plaintext passwords).
- `/room/expense` with a valid `roomId` and valid ObjectIds, and the broadcast to sockets that joined, if CORS allowed them to connect.

**Broken:**
- **The frontend can't load** because of the unresolved `react-d3-graph` import (`Graph.js:3`).
- Even with that fixed, **the UI can't leave the login screen** (`Auth.js:5` ignores `onJoinRoom`).
- **Real-time is likely blocked by CORS** (`server.js:12`).
- **Add expense is hardcoded** and its ids are invalid (`Room.js:27`).
- **No async error handling** in any route. Express 4 does not catch rejected promises, and Node 22 exits on an unhandled rejection by default, so **a single bad request crashes the server**. Examples:
  - `POST /room/join {"roomId":"x"}` (CastError).
  - `POST /room/expense` with an unknown id: `room` is `null`, so `room.expenses` throws a TypeError (`server.js:81`).
  - `POST /login {}`: Mongoose drops `undefined` filter keys, so `findOne({})` returns the *first user*, then `bcrypt.compare(undefined, hash)` throws. **This is an unauthenticated crash.**
  - `POST /register` without a password saves a user with no hash. A later login for that email throws.
- `mongoose.connect` is neither awaited nor given a catch handler (`server.js:18`). If Mongo is down, startup fails with an unhandled rejection.
- Emails have no uniqueness, so duplicate accounts are possible and login picks one arbitrarily.
- Repeated joins push duplicate user ids (`server.js:72`).

**Missing entirely:** balances, split types, settlements, editing or deleting expenses, room listing, member names, debt simplification, a `start` script, env config, README, and tests.

**Dead code:** `routes/auth.js` and `routes/room.js` are never `app.use`d.

---

## 4. Money handling

- **Storage:** `amount: Number` (`Room.js:11`), an IEEE-754 double stored as a BSON double. There is no validation, so negative, zero, `NaN`-castable, or huge values are accepted. There is no currency field.
- **Splits:** **none are computed anywhere.** An expense is just `{payer, amount, participants}`, and the meaning is undefined: is the payer a participant? Equal split only? Nothing says.
- **Rounding:** not applicable yet, because no division happens. The UI's example "Rs 50 for B, C, D" (`Room.js:27,40`) would give 16.666… per person if anyone divided it. Each share would lose precision, and the shares would not provably sum back to 50.00.
- **Float risk points:**
  1. Storing rupees as a double. For example, `1.15 * 100 === 114.99999999999999` in JS, so naive rupee-to-paise conversion drops a paisa.
  2. Any future division of `amount` by participant count.
  3. Summing many doubles to compute balances, where error accumulates and Σ balances ≠ 0.

The rewrite must store **integer paise** (Postgres `bigint`, JS integers checked with `Number.isSafeInteger`, or BigInt). It must parse user input from **decimal strings** (never `parseFloat(x) * 100`) and allocate remainders deterministically (see the plan).

---

## 5. Security review

Severity assumes the app is deployed as intended (internet-facing). Today it is local-only and runs nowhere.

| # | Severity | Finding | Where |
|---|---|---|---|
| S1 | **Critical** | **Hardcoded JWT signing secret.** A short dictionary-word string literal is passed as the `secretOrPrivateKey` argument (not read from env) to `jwt.verify` and `jwt.sign`. Anyone who reads the source can forge a token for any user id and impersonate anyone. The value is not reproduced here. | `backend/server.js:33` (verify), `backend/server.js:55` (sign), `backend/routes/auth.js:24` (sign, dead code) |
| S2 | **Critical** | **IDOR on expenses.** `/room/expense` checks only that the caller is logged in, not that they belong to the room. Any user can add an expense to any room, set any `payerId`, and choose any participants. | `server.js:77-82` |
| S3 | **High** | **Room password disclosure.** `/room/join` and `/room/expense` return the whole Room document, including the plaintext password. Combined with S2, knowing a `roomId` is enough to leak the room password. | `server.js:74`, `server.js:84` |
| S4 | **High** | **Unauthenticated, unscoped sockets.** `joinRoom` accepts any room id from anyone, with no token. Anyone with a room id receives every expense broadcast. | `server.js:87-92` |
| S5 | **High** | **Remote crash (DoS).** Unhandled async errors kill the process, including an unauthenticated `POST /login {}`. | §3 |
| S6 | **High** | **Room passwords stored and compared in plaintext**, with a non-constant-time `!==` comparison. | `Room.js:6`, `server.js:69` |
| S7 | Medium | **NoSQL operator injection.** `findOne({ email })` with `email` straight from JSON lets a client send `{"$regex": ...}` or `{"$ne": null}` (`sanitizeFilter` is off). It can't bypass the bcrypt check, but it enables account enumeration and the crash path. | `server.js:51` |
| S8 | Medium | **No input validation anywhere:** types, lengths, email format, password policy, or amount sign/size. Mass assignment is limited only because handlers destructure fields. | all routes |
| S9 | Medium | **CORS wide open.** `app.use(cors())` allows any origin. The impact is limited because auth is a bearer header, not a cookie. | `server.js:14` |
| S10 | Medium | **Token stored in `localStorage`** and sent as a raw header, so any XSS steals the session. There is no revocation or logout, and the 1h expiry has no refresh. | `Auth.js:14`, `Room.js:24-28` |
| S11 | Medium | **No rate limiting** on login/register (credential stuffing, bcrypt CPU exhaustion) or anywhere else. There is no `express.json` body limit beyond the 100 kb default. | `server.js` |
| S12 | Low | Hardcoded Mongo URI with no credentials (`server.js:18`); fine locally. Invalid token returns 400 instead of 401. No security headers. | |
| S13 | Low (dead code) | `routes/room.js` trusts `userId` from the request body and has no auth. If someone mounted it, it would be Critical. | `routes/room.js:9,17` |

- **Password hashing:** bcryptjs, cost 10, in a pre-save hook. That is acceptable but minimal; cost 12 or argon2id would be better, and there is no length policy.
- **Other secrets:** no `.env` files and no other keys found in the source or config.

---

## 6. Git

- The project folder is **not a git repository**, and neither is any parent directory (`git rev-parse` fails in both). That matches INVENTORY.md.
- So there is no remote, no commits, and no history to search. **The JWT secret has never been committed from this folder.** I can't check whether a copy of this code was ever uploaded elsewhere (for example, pasted into a GitHub repo by hand); that is unclear.
- `frontend/.gitignore` exists (from the Vite template). The backend has none, so `backend/node_modules` would be committed by a naive `git init && git add .`.

## 7. Tests

None. `backend/package.json:7` is npm's placeholder `test` script, which exits 1. The frontend has no test runner. Coverage is 0%.

## 8. Salvageable vs throwaway

| Item | Verdict |
|---|---|
| Product idea (groups, live updates, debt graph) | Keep |
| `server.js`, models, routes | Throw away. ~100 LOC, wrong data model (floats, embedded unbounded arrays, plaintext room passwords), insecure auth |
| Frontend components | Throw away. Three stubs with hardcoded data |
| Tailwind/PostCSS/ESLint config | Trivial to regenerate |
| `node_modules`, lockfiles | Discard and regenerate with current, pinned versions |

**A rewrite is justified:** there is no balance or split logic to preserve, the data model has to change (integer minor units, separate expense/split/settlement entities), and every existing endpoint needs authz added. A fresh start costs less than patching.

---

# PROPOSED PLAN (for review; not started)

## A. Stack: keep MongoDB or move to PostgreSQL?

**Case for MongoDB:**
- The existing code and the author's experience use it.
- Multi-document ACID transactions exist (4.0+), but they need a replica set, even a single-node one, which adds setup the current code doesn't have.
- `$jsonSchema` validators can enforce types.
- Amounts can be stored as `long` (int64).
- Aggregation pipelines can compute balances.
- Flexible documents suit the activity-log payloads.

**Case for PostgreSQL** (for a *money ledger* specifically):
- **Constraints in the database, not just the app:** `CHECK (amount_minor > 0)`, `CHECK (from_user <> to_user)`, foreign keys from splits to memberships, and `UNIQUE (group_id, seq)` on the activity log.
- **A deferred constraint trigger** can enforce "Σ splits = expense total" and "Σ payers = total" at COMMIT. Mongo has no equivalent cross-document invariant.
- **Transactions are first-class** with no replica-set requirement. `SERIALIZABLE` or row locks (`SELECT … FOR UPDATE` on the group) give a gap-free per-group sequence.
- **`bigint` minor units** with exact `SUM()`. You can't accidentally store a double because the column type forbids it.
- **Auditability:** append-only can be enforced with `REVOKE UPDATE, DELETE` for the app role plus a trigger that raises on UPDATE/DELETE of `activity_log`. Balances are a plain `GROUP BY` view, easy to verify by hand in `psql`.
- **Relational shape:** users ↔ groups ↔ memberships ↔ expenses ↔ splits is many-to-many all the way. Mongo forces either unbounded embedded arrays (the current bug) or manual joins.
- **Operational fit:** dbmate migrations and the same Postgres tooling as CodeJudge, so there is one mental model across projects.

**Costs of moving:** schema migrations are needed (dbmate handles them), and there is a small learning curve.

**Recommendation: PostgreSQL**, plain SQL via a thin typed query layer, with dbmate migrations. A ledger is exactly the case where database-enforced invariants and transactions matter more than schema flexibility.

Other stack choices, pinned to exact versions in Phase 1:
- **Language:** TypeScript everywhere.
- **API:** Node 22 LTS with Express 5 (or Fastify), validated by zod.
- **Real-time:** Socket.IO 4.x.
- **Web:** React + Vite + TanStack Query + Tailwind.
- **Tests:** Vitest + fast-check (property tests) + Playwright (e2e).
- **Local infra:** Docker Compose project `hisaab` with Postgres on host port **5434** and volume `hisaab_pg`. The API runs on **8081** and the web app on **5174**. Valkey (**6380**) only if horizontal scaling is ever needed, so not in v1.

## B. Core domain model

All money is **`bigint` paise** (integer minor units). Each group has one ISO-4217 currency in v1; multi-currency is out of scope.

```
users         (id uuid pk, display_name, email citext unique null, created_at)
identities    (user_id fk, provider, subject, unique(provider, subject))     -- OIDC / magic-link
sessions      (id, user_id fk, token_hash bytea unique, created_at, expires_at, revoked_at)
groups        (id, name, currency char(3), simplify_debts bool, created_by, created_at)
memberships   (group_id fk, user_id fk, role {owner,member}, joined_at, left_at, pk(group_id,user_id))
invites       (id, group_id fk, token_hash unique, created_by, expires_at, max_uses, uses)
expenses      (id, group_id fk, description, total_minor bigint check > 0,
               split_kind {equal,exact,percent,shares}, occurred_on date,
               created_by, created_at, deleted_at null, replaces_id null fk -> expenses)
expense_payers(expense_id fk, user_id fk, paid_minor bigint check > 0)        -- Σ = total (deferred trigger)
expense_splits(expense_id fk, user_id fk, input_value bigint, owed_minor bigint check >= 0)
               -- input_value: exact paise | basis points (Σ=10000) | integer shares; Σ owed = total
settlements   (id, group_id fk, from_user, to_user, amount_minor check > 0,
               check(from_user <> to_user), created_by, created_at, deleted_at null)
activity_log  (group_id fk, seq bigint, id uuid, actor_id, type, entity_id, payload jsonb, created_at,
               pk(group_id, seq))    -- append-only: trigger rejects UPDATE/DELETE, app role REVOKEd
idempotency_keys (user_id, key, response, created_at)                          -- safe retries on POST
```

- **Placeholder members:** a friend can be added by name before signing up. They become a `users` row without an identity, which is claimed when they accept an invite. This matters for adoption.
- **Edits are not in-place:** an edit soft-deletes the old expense and inserts a new one with `replaces_id`, in one transaction, with one `expense.updated` activity row that holds before and after snapshots. Every past state can be reconstructed.
- **Every write** is one transaction that does four things in order: lock the group row, validate membership, apply the change, then append to `activity_log` with `seq = last + 1`.
- **Net balance** of member *u* is:

  Σ `paid_minor` − Σ `owed_minor` + Σ settlements sent − Σ settlements received,

  counting only non-deleted rows. The invariant **Σ net = 0** is checked in tests and in a DB assertion query.

### Deterministic rounding (allocation of T paise)

Integer allocation is centralised in one pure function `allocate(T, weights, tiebreakKey)`.

**Tie-break order:** sort participants by `sha256(expense_id ‖ user_id)`. The order is deterministic and reproducible, but it doesn't always penalise the same person, which sorting by name would.

**Rules by split kind:**
- **Equal (k people):** `q = floor(T/k)`, `r = T − q·k`. The first `r` people in tie-break order owe `q+1`; the others owe `q`.
- **Percent:** weights are integer basis points summing to 10000. **Shares:** weights are positive integer shares, and W = Σ shares. Both use the **largest-remainder method**: `base_i = floor(T·w_i / W)`, then hand out the leftover paise one each to the largest remainders `(T·w_i mod W)`. Ties go by the same tie-break order.
- **Exact:** the inputs must sum to exactly T, otherwise the request is rejected with 422. No silent adjustment.

**Guarantees:** shares are integers, they sum exactly to T, and every share is within 1 paisa of its exact rational value.

**Input:** amounts are parsed from decimal strings (`"123.45"`) with string arithmetic. More than 2 decimals is rejected (or more than the currency's minor-unit exponent).

## C. Debt simplification

**Input:** nonzero net balances b₁..bₙ (in paise), with Σ = 0. **Output:** a list of transfers (debtor → creditor, amount) that zeroes every balance.

**Pre-step (both algorithms):** remove zeros, then cancel exactly opposite pairs (+x, −x) into one transfer each. This is safe: if +x and −x were in different zero-sum groups G₁ and G₂, then G₁ ∪ G₂ splits into {+x, −x} and the rest, both zero-sum, so the group count doesn't drop.

**(a) Greedy (max-creditor / max-debtor):**
- Keep two max-heaps. Each step, pop the largest creditor *c* and the largest debtor *d*, transfer `min(c, |d|)`, and push back the leftover.
- Every step zeroes at least one person, so there are **≤ n − 1 transfers**.
- Cost: O(n log n) time, O(n) space.
- Not always optimal. Counterexample: balances {+3, +2, +2, −4, −3}.
  - Greedy: 4 transfers. Label the balances A=+3, B=+2, C=+2, D=−4, E=−3. Greedy goes D→A 3, E→B 2, D→C 1, E→C 1.
  - Optimum: 3 transfers ({+3, −3} and {+2, +2, −4}).

**(b) Exact minimum (bitmask DP):**
- Finding the minimum number of transfers is NP-hard in general. For n nonzero members:

  **min transfers = n − (maximum number of disjoint zero-sum subsets partitioning the members)**

  A zero-sum group of size k can always be settled in k − 1 transfers, and never in fewer.
- Steps:
  1. Compute `sum[mask]` for all 2ⁿ masks, in O(2ⁿ) using the lowest set bit.
  2. Compute `dp[mask] = max over i in mask of dp[mask \ {i}]`, plus 1 if `sum[mask] == 0`. The answer is `n − dp[full]`.
  3. Reconstruct by walking back from `full`, removing the element that achieved the max. The masks along that chain where `sum == 0` mark the group boundaries; the difference between consecutive boundaries is a zero-sum group.
  4. Settle each group with greedy, which uses exactly k − 1 transfers inside a zero-sum group of size k.
- Cost: O(2ⁿ · n) time, O(2ⁿ) memory. n = 20 is about 21M simple operations and about 12 MB with typed arrays: fine on the server, tens of ms.

**(c) When to use which:**
- Run exact when the nonzero count after the pre-step is **≤ 18**. Tune the cutoff from a benchmark in Phase 3; it is the threshold that keeps p99 under ~50 ms on the deploy box.
- Otherwise run greedy. A typical friend group (≤ 15 people) always gets the exact answer.
- Simplification is a **derived view computed on read**. It is never stored as ledger truth. Settling up records ordinary `settlements` rows.
- Respect each group's `simplify_debts` flag. When it is off, show pairwise debts derived from the expense rows.

**Property-based test plan** (fast-check, ≥ 10k runs per property; random groups of 1–20 members, random expenses across all four split kinds, random settlements):
1. **Allocation:** Σ shares = T; every share ≥ 0; |share − exact rational| < 1 paisa; same inputs produce the same output.
2. **Conservation:** Σ net balances = 0 after any sequence of creates, edits, deletes, and settlements.
3. **Every debt settled:** applying the transfer list to the balances gives all zeros, for both algorithms.
4. **Well-formed transfers:** amounts are positive integers, from ≠ to, money flows only from debtors to creditors, and nobody both pays and receives.
5. **Bounds:** greedy ≤ n − 1; **exact ≤ greedy**; exact equals the brute-force optimum for n ≤ 7 (enumerate set partitions).
6. **Known cases:** the {+3, +2, +2, −4, −3} counterexample gives 3 (exact) and 4 (greedy).
7. **Determinism:** shuffling the input order doesn't change the result once ids are canonically sorted.

## D. Real-time

**Authentication and scoping:**
- Socket.IO authenticates in an `io.use` middleware on the handshake: it reads the **session cookie** and checks the **Origin header against an allowlist**, which blocks cross-site WebSocket hijacking.
- The server, not the client, decides rooms. On connect it joins the socket to `group:<id>` for each active membership. A client `subscribe(groupId)` is ack'd only after a membership check.
- Clients send **no mutations over the socket**. All writes go through REST, so there is a single validation and authorization path.

**Server → client events** (emitted **after COMMIT** only):
- `activity` `{groupId, seq, type, entityId}`, where `type` is one of `expense.created|updated|deleted`, `settlement.created|deleted`, `member.joined|left`, or `group.updated`.
- `membership.revoked` `{groupId}`. The server then calls `socketsLeave` for that user's sockets. Revoking a session disconnects its sockets.

**What the client sees on reconnect:**
- REST is the source of truth, and events are notifications.
- The client loads a snapshot (balances plus recent activity) that includes `lastSeq`.
- On each event: if `seq == lastSeq + 1`, apply it (or invalidate the TanStack Query cache); if `seq ≤ lastSeq`, ignore it as a duplicate; if there is a gap, fetch `GET /groups/:id/activity?after=lastSeq`.
- On reconnect it always does that same catch-up fetch.
- **Result:** delivery is at-least-once with client-side dedupe, and the client converges to the committed state within one round trip. There is no ordering ambiguity, because `seq` is assigned inside the write transaction under the group lock.
- A single API instance needs no adapter. Scaling out later adds the Valkey adapter on 6380.

## E. Auth for a "friends" app

| Option | Pros | Cons |
|---|---|---|
| Email + password | Familiar | Needs reset emails anyway, credential stuffing, password storage |
| Email magic link | No passwords, works for anyone with email | Needs an email provider and deliverability; link-in-email latency |
| Google OIDC | One tap for almost every student/friend, no password storage | Excludes the rare non-Google user; depends on Google |
| GitHub OAuth (as in CodeJudge) | Already familiar to the author | **Most friends don't have GitHub**, so it doesn't fit |
| Passkeys | Best security and UX | Recovery still needs email; uneven device support among friends |
| Phone OTP | Very common in India | SMS cost, Indian DLT sender registration, SIM-swap risk |

**Recommendation:**
- **Google sign-in, with email magic link as the fallback** for everyone else. Passkeys can be added later.
- **Server-side sessions**, not JWTs: an opaque 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie, stored **SHA-256-hashed**, with expiry, revocation, and logout everywhere.
- **Invite links:** random 128-bit token stored hashed, group-scoped, with expiry and max uses. Accepting one can claim a placeholder member.
- **CSRF:** SameSite cookies plus an Origin check on state-changing requests.
- **Dev only:** a dev-login that refuses to start unless `NODE_ENV=development`, so Phases 2–6 aren't blocked waiting for the real providers.

## F. Phases

| # | Phase | Scope | Done means |
|---|---|---|---|
| 0 | Audit | This document | You've reviewed AUDIT.md and the decisions in §A–E are confirmed or changed |
| 1 | Foundations | `git init` (with .gitignore before the first add); monorepo `apps/api`, `apps/web`, `packages/money`; TypeScript, ESLint, Prettier; compose project `hisaab` (PG on 5434, volume `hisaab_pg`); dbmate; `/healthz`; CI (lint, typecheck, unit tests); secret scanning; old code moved to `legacy/` or deleted | `docker compose up` (project `hisaab`) starts PG; API on 8081 and web on 5174 respond; CI is green; secret scan is clean; nothing collides with CodeJudge ports or project names |
| 2 | Domain + ledger | Schema migrations; `allocate()` and decimal parsing; groups, memberships, invites, placeholder members, expenses (4 split kinds), settlements, balances, activity log; zod validation; per-group authz; idempotency keys | Integration tests against real Postgres show: Σ balances = 0; an UPDATE or DELETE on `activity_log` fails at the DB; another group's ids return 404; a split sum ≠ total is rejected by the DB trigger even if the app check is bypassed |
| 3 | Simplification | Pure `simplify` package: greedy plus exact, with a threshold | All properties in §C pass at ≥ 10k runs; exact matches brute force for n ≤ 7; the n = 20 benchmark is recorded and the threshold set from it |
| 4 | Real-time | Socket auth, server-assigned rooms, post-commit `activity` events, catch-up endpoint | Tests show a non-member can't subscribe and a bad Origin is rejected; two clients converge after one goes offline and misses N events |
| 5 | Frontend | Group list, group page (balances, simplified settle-up, activity feed), add/edit expense with the 4 split modes and a live "remaining ₹x" indicator, settle up, invites; mobile-first | A Playwright e2e passes: create group → invite → add each split type → settle → balances reach zero in both browsers |
| 6 | Auth + limits | Google OIDC, magic link, hashed sessions, invite flow; rate limits (strict per IP and per account on auth, per user on writes); body size limits; security headers; Origin/CSRF checks | Tests cover rate limiting (429), Origin rejection, session revocation that kills sockets, and invite expiry; dev-login refuses to start outside development; §5 findings re-checked against the new code |
| 7 | Deploy | Infra as code; secrets in a parameter store; migrations on deploy; DB backups and restore drill; HTTPS | Public URL works; a restore from backup has been tested; rollback is documented; no secret appears in the repo or image |

The order follows your list, except that "auth/limits" sits after the frontend. The dev-login lets that order hold without shipping anything insecure.

## G. Ideas to reuse from CodeJudge (named only; no code copied, and `../CodeEditor` was not opened)

- **Sessions hashed at rest:** an opaque cookie token, stored as its SHA-256 hash, with expiry and revocation (§E).
- **Origin check:** an allowlist on both HTTP mutations and the Socket.IO handshake (§D).
- **Rate limiting:** layered per IP and per user, strictest on auth.
- **dbmate migrations:** plain SQL, forward-only, run in CI against a throwaway database.
- **CI layout:** lint, typecheck, unit tests, and integration tests (a Postgres service) as separate jobs, plus secret scanning.
- **CDK/SSM deploy:** infrastructure as code, with secrets in SSM Parameter Store and none in env files or images.
- **Coexistence conventions:** a distinct compose project name, distinct host ports, and a resource prefix (`hisaab_`).
