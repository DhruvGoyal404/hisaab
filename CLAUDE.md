# Hisaab

Hisaab is a group expense-sharing app. Friends create a group, record who paid for what and how it is split (equal, exact amounts, percentages or shares), see live balances, and settle up with as few transfers as possible. Friends can be added by name before they sign up and claim their place later through an invite link.

Never use the name of the trademarked app this is modelled on in UI, repo, package names or docs. The folder name is legacy and stays for now.

## Architecture target

| Part | Stack | Port |
|---|---|---|
| `api/` | Node 22, TypeScript strict, Express 5, zod, pg, pino | 8081 |
| `web/` | Vite, React 19, TypeScript strict, Tailwind v4, TanStack Query, React Router | 5174 (proxies `/api` to 8081) |
| `packages/money/` | `@hisaab/money`: allocate(), money parsing/formatting; pure TS, no Node built-ins, imported by api and web | |
| `db/migrations/` | PostgreSQL 18, plain-SQL migrations via dbmate | host 5434 |
| Real-time (Phase 4) | Socket.IO, cookie-authenticated, server-assigned group rooms | shares 8081 |
| Auth (Phase 6) | Google OIDC (code + PKCE, `openid email profile`, require `email_verified`) and GitHub sign-in; server-side sessions | |

The audit and design rationale are in [docs/AUDIT.md](docs/AUDIT.md); the implemented schema in [docs/SCHEMA.md](docs/SCHEMA.md); settlement algorithms and their measured thresholds in [docs/ALGORITHMS.md](docs/ALGORITHMS.md); the real-time design in [docs/REALTIME.md](docs/REALTIME.md).

## Commands

```sh
npm ci                           # root; npm workspaces: api, web. Installs exactly what package-lock.json says
docker compose up -d db          # Postgres 18 on localhost:5434 (project "hisaab")
npm run db:migrate               # dbmate up as the owner role (MIGRATE_DATABASE_URL, see api/.env.example)
npm run db:bootstrap             # dev: create the API's login role (DATABASE_URL creds) as a member of hisaab_app
npm run dev:api                  # API on :8081
npm run dev:web                  # web on :5174
npm run typecheck && npm run lint && npm test
npm run test:int                 # API integration tests: creates, migrates and drops a throwaway DB (needs MIGRATE_DATABASE_URL)
npm run e2e -w web               # Playwright on its own throwaway DB with fresh servers (stop the dev servers first)
```

## Phases

| # | Phase | Done means |
|---|---|---|
| 0 | Audit | AUDIT.md reviewed; stack, auth and legacy-code decisions made. **Done.** |
| 1 | Foundations | Compose Postgres on 5434, API on 8081 and web on 5174 respond; CI green; no secrets in the repo; nothing collides with CodeJudge ports or project names |
| 2 | Domain + ledger | Integration tests on real Postgres prove Σ balances = 0, UPDATE/DELETE on `activity_log` fails at the DB, another group's ids return 404, and a split sum ≠ total is rejected by the DB even if the app check is bypassed. **Done.** |
| 3 | Simplification | Property tests (≥10k runs) pass; exact matches brute force for n ≤ 7; n = 20 benchmark recorded and greedy/exact threshold set from it. **Done** (see docs/ALGORITHMS.md). |
| 4 | Real-time | Tests: non-member can't subscribe, bad Origin rejected, two clients converge after one misses N events while offline. **Done** (see docs/REALTIME.md). |
| 5 | Frontend | Playwright e2e: create group → invite → add each split type → settle → balances reach zero in both browsers. **Done** (web/e2e/journey.spec.ts). |
| 6 | Auth + limits | Tests for rate limiting (429), Origin rejection, session revocation killing sockets, invite expiry; dev login refuses to start outside development/test |
| 7 | Deploy | Public URL; backup restore tested; rollback documented; no secret in repo or image |

## Invariants (do not break these)

- **Money is BIGINT minor units (paise), never floats, anywhere.** DB columns are `bigint`; API JSON carries integers; amounts are parsed from decimal strings, never `parseFloat(x) * 100`. The frontend formats only at display time.
- **One allocation function for all splits**, with a deterministic remainder rule (largest remainder; ties broken by `sha256(expense_id ‖ membership_id)`). Shares always sum exactly to the total.
- **The activity log is append-only, enforced by the DB** (trigger plus REVOKE), not just by app code.
- **Sessions are opaque tokens, stored hashed (SHA-256) at rest.** No JWT. HttpOnly cookie. **Origin check on every non-GET request.**
- **Clients never write over the socket.** All writes go through REST; sockets only notify.
- **Dependencies: exact versions pinned, and only releases at least 14 days old.** `.npmrc` has `save-exact=true`. Normal installs and CI use `npm ci` (lockfile only, no resolution). The `--before` cutoff applies only when adding or upgrading: `npm install <pkg>@<version> --before=<date 14 days ago>`, which also keeps newly resolved transitive deps at least 14 days old. CI fails on `npm audit --audit-level=high`.
- Node stays on the machine's 22.19 while CodeJudge runs, so React Router 7 and jsdom 29 (their next majors need Node ≥ 22.22).
- The dev login (`/api/dev/login`) exists only when `NODE_ENV` is `development` or `test`; the API refuses to start if it is enabled anywhere else.

## Coexistence rules (shared machine)

Another project (CodeJudge, in `../CodeEditor`) runs on this machine at the same time.

- Stay inside this folder. Never read, modify or run anything outside it, except reading `../INVENTORY.md`.
- Hisaab ports: web **5174**, API **8081**, Postgres host port **5434**, Valkey/Redis **6380** if ever needed. CodeJudge owns 5173, 8080 and its own Postgres/Valkey ports.
- Compose project name **`hisaab`**; volumes prefixed `hisaab_`. Never use the `codejudge` project name.
- Docker Desktop is shared: never stop, remove, prune or restart containers, images or volumes Hisaab didn't create. Never touch anything labelled `judge.managed` or in the `codejudge` project. Never change Docker Desktop settings.
- RAM is tight (WSL capped at 6 GB, CodeJudge runs heavy sandbox tests). Postgres is limited to 256 MB. Don't leave long-running services up without reason, and ask before heavy installs.
- CI minutes are shared with CodeJudge's private repo: keep workflows lean (one job, cancel superseded runs, skip docs-only changes).

## CI and verification rules

- **Every CI step that pipes output must run with `set -o pipefail`** (or `shell: bash`, which GitHub runs as `bash -eo pipefail`), or avoid pipes. The default `bash -e` returns the last command's status, so `cmd | tee` hides failures. That has happened twice.
- The same applies locally: never decide pass/fail from filtered output (`… | grep`). Capture the output to a file, check the command's exit code, then read the file.
