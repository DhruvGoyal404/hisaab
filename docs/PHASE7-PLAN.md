# Phase 7 plan: Hisaab on the shared Azure VM

Status: **plan approved 2026-10-30, building.** Decisions:
- Host logic: a vendored copy pinned to a Chitthi commit.
- Tags: a small upstream change in Chitthi (`app-<name>: up|down`; `hosted` read as up).
- Isolation: Hisaab owns everything (resource group, vaults, storage, R2 bucket).
- Repository: made public before deploy, after a fresh secret scan.

Before approval: No cloud resource has been created or changed. Facts checked read-only on 2026-10-30:
- `apps-vm`: B2ats v2 in `malaysiawest`, deallocated, tagged `app-chitthi: hosted`.
- Resource groups `apps-host` and `chitthi`.
- One budget, `apps-host`: ₹500 a month at subscription scope, ₹61.91 spent this month.

The design is Chitthi's (github.com/DhruvGoyal404/chitthi, `docs/MAINTENANCE.md` and `deploy/`), and Chitthi's MAINTENANCE.md "Adding the second app (Hisaab)" already reserves Hisaab's slot: uids 10020/10021, `/srv/hisaab`, `/data/hisaab`, loopback ports 8081/5174, `sites/hisaab.caddy`, `/run/hisaab-deploy.lock` plus the shared `/run/edge-deploy.lock`. This plan follows that table and reuses every lesson Chitthi paid for.

Effort: **S** under 2 hours, **M** about half a day, **L** about a day.

## 1. Gap list against Chitthi

| # | Item | Hisaab today | Needed | Effort |
|---|---|---|---|---|
| 1 | Production config | `DEV_LOGIN` and the OAuth endpoint overrides are refused in production (config and real process). No `TRUST_PROXY`, so behind Caddy every request has the same IP and the per-IP sign-in limit would be shared by everyone. | `TRUST_PROXY=1` (exactly one hop), `PUBLIC_URL` required and https in production, `NODE_ENV` pinned in the image and compose. | S |
| 2 | Dev-switch refusal tests | Config and process tests for `DEV_LOGIN` only. | `api/test/production.test.ts` like Chitthi's: every dev key refused by name, the production route table has no `/api/dev/*`, the real process exits 1 and never prints the database URL. | S |
| 3 | Production images | None. | Three images built in CI and pushed to GHCR by digest: `hisaab-api` (Node 22.19 Alpine, pinned digest, non-root, `tsc` build), `hisaab-migrate` (dbmate plus `db/migrations`), and `hisaab-web` (Caddy serving `dist/` with the page headers). | M |
| 4 | Page CSP and headers | helmet on the API only. | In the web image's Caddyfile: `default-src 'self'` and friends, plus `frame-ancestors 'none'`, nosniff, DENY, no-referrer, COOP and Permissions-Policy, as Chitthi does. Fonts are bundled (`@fontsource`) and Socket.IO is same-origin, so `'self'` covers everything. A test keeps the meta CSP and the Caddyfile equal. | S |
| 5 | Production compose | Dev compose only. | `deploy/hisaab/compose.yaml`: project `hisaab`; uids 10020 (api, migrate) and 10021 (db); data under `/data/hisaab/pg`; ports `127.0.0.1:8081` and `127.0.0.1:5174`; an internal `backend` network; read-only, `cap_drop ALL`, `no-new-privileges`; `mem_limit` on every service (section 4). | S |
| 6 | Edge site file | None. | `deploy/edge/sites/hisaab.caddy`: `/api/*` (REST and WebSocket) to 8081, the rest to 5174, HSTS without includeSubDomains, a 1 MB body cap. Validated against the whole edge config before install. | S |
| 7 | Host deploy script | None. | `deploy/host/deploy.sh`, adapted from Chitthi's:<br>• Fetch config at a commit and write env files from Key Vault through the VM identity.<br>• Pull by digest, dump the database before the switch, migrate, start.<br>• Install only `hisaab.caddy` under `/run/edge-deploy.lock` and reload the edge.<br>• Smoke-test, with automatic rollback if anything fails after the switch.<br>• Also creates Hisaab's own users and directories idempotently, so Chitthi's `bootstrap.sh` needs no change. | M |
| 8 | Backups | None. | `deploy/host/backup.sh`, adapted: a nightly `pg_dump` encrypted with age to Azure Blob (create-only role, 403 on a duplicate create counts as "refused") and to R2 via curl (409 under the bucket lock counts as "refused"). Plus a monthly restore drill into a scratch database, `selftest`, `restore`, and healthchecks pings. No media to back up. | M |
| 9 | Azure app setup | None. | `deploy/azure/setup.sh`, app half only. Resource group `hisaab` with its own Key Vault, ops vault, backup storage and container, and deploy identity (`hisaab-deploy`), plus a federated credential on the immutable subject `repo:DhruvGoyal404@<id>/hisaab@<id>:environment:production`. Chitthi's custom roles (create-only writer, Run Command operator) are reused, assigned at Hisaab's own scopes. Create-or-update everywhere. | M |
| 10 | CI images job and deploy workflow | CI has no images job. | An `images` job in `ci.yml` (build, check size and non-root, smoke-test the stack). `deploy.yml` copied from Chitthi: gate, build, deploy jobs with the same minimal permissions, the `production` environment with a required reviewer, and a `DEPLOY_ENABLED` variable. | M |
| 11 | Memory measurement | None. | The Hisaab stack under a workload in CI (`deploy/smoke/workload.mjs`: sockets, expenses at the rate limits, a settle-up), sampling cgroup memory. CI fails on an OOM kill or above 90 % of a limit. | M |
| 12 | `/privacy` and `/terms` | None. | Two static pages. Google's consent screen needs a privacy policy URL for a published app. The text says what is stored (name, email, provider ids, the ledger), why, for how long, and how to delete the account (already built in Phase 6). | S |
| 13 | Server-side avatars | Hisaab never shows avatars; `avatar_url` is always null. | **Nothing.** Showing none means no third-party images and no `img-src` exceptions. Skipped unless you want avatars. | 0 |
| 14 | Rate limits | Done in Phase 6, on Postgres. | Only `TRUST_PROXY` (item 1), so the IP is the client's. | 0 |
| 15 | e2e isolation | Done in Phase 5 (throwaway database per run). | Nothing. | 0 |
| 16 | `hisaab-up.sh`, `hisaab-down.sh` | None. | Section 6. | M |
| 17 | `docs/MAINTENANCE.md` | None. | Layout, going live, up and down, deploy and rollback, backups, incidents, costs, memory. | M |

Total: about 5 days of pieces, each its own commit with CI green.

## 2. Shared host logic

The host scripts (`lib.sh`, `host-up.sh`, `host-down.sh`, `audit.jq`, `run-on-vm.sh`) live in the Chitthi repo. The options are in the questions at the end. **Recommended: a vendored copy pinned to a Chitthi commit**, in `deploy/azure/` here:
- `VENDORED.md` names the commit.
- A CI step checks that the copy matches that commit byte for byte, except one clearly marked block of app constants (`KV`, `OPS_KV` names).
- Updating means bumping the pin. Nothing calls into the other repo at run time, so neither app's up or down can break because the other repo moved.

**Tags must say which apps are up, not only which apps live there.** Today a tag `app-<name>: hosted` is set on up and never removed, so `host-down.sh` refuses whenever any other app is hosted, even when it is down. The change:

| Script | Writes |
|---|---|
| `<app>-up.sh` | `app-<name>: up` |
| `<app>-down.sh` (with or without `--app-only`) | `app-<name>: down` |

`host-down.sh` then refuses to deallocate while another app's tag is `up` (or the legacy `hosted`, treated as up), unless `also=` names it. `host-up.sh` is safe to call while the VM runs. This change belongs upstream in Chitthi, because both apps must read the tags the same way. It needs your permission, since that repo is outside this folder.

What each script does to the other app:

| You run | Chitthi is down | Chitthi is up |
|---|---|---|
| `hisaab-up.sh` | host up, then Hisaab's DNS, health and monitors. Chitthi's containers start with the VM (restart policy) but its DNS stays parked: a running but unreachable app. | `--app-only` behaviour automatically: the host is already up, so only Hisaab's steps run. |
| `hisaab-down.sh` | Hisaab's steps, then the host down, then the audit. | Hisaab's steps only (backup, monitors paused, DNS parked, tag `down`). The VM keeps running for Chitthi. The script says so and prints Chitthi's cost. |

## 3. Isolation on the VM and in Azure

| Piece | Hisaab's own | Shared with Chitthi |
|---|---|---|
| Compose project | `hisaab` in `/srv/hisaab` | - |
| Linux users | `hisaab` 10020, `hisaab-db` 10021 | - |
| Data | `/data/hisaab/pg` (0700, uid 10021), `/data/hisaab/pre-deploy` | the data disk |
| Postgres | its own container, `max_connections=20`, tuned like Chitthi's | - |
| Secrets | Key Vault `hisaab-kv-<sfx>` (VM identity reads); ops vault `hisaab-ops-<sfx>` (the up and down scripts only; the VM has no access) | - |
| Backups | its own storage account and container in resource group `hisaab`; its own R2 bucket with its own 30-day lock; its own healthchecks | the R2 account |
| Edge | `sites/hisaab.caddy`, written only by Hisaab's deploy | the edge container, its Caddyfile and `/run/edge-deploy.lock` |
| Deploy identity | `hisaab-deploy`, OIDC trust for this repo's `production` environment only, managed Run Command on `apps-vm` only | the VM |
| GitHub | environment `production` in this repo, a required reviewer, `DEPLOY_ENABLED` | - |
| Containers' egress | Google and GitHub OAuth only, through the `egress` network; Postgres on the internal network | iptables guard on the metadata service (root only), already installed by Chitthi's bootstrap |

## 4. Memory budget, both apps busy

Hisaab hasn't been measured yet: there are no production images. Its measurement is gap item 11, before go-live. These are the known figures (Chitthi's measured, your VM facts) and Hisaab's estimates:

| MiB | Steady | Busy |
|---|---|---|
| VM total | 836 | 836 |
| OS, agent, dockerd, containerd, shims (your figure) | 297 | 297 |
| Edge Caddy (measured) | 16 | 24 |
| Chitthi db + api + web (measured) | 107 | 226 |
| **Hisaab, estimated:** db 26 / 59, api 55 / 90 (Node, Socket.IO, pg; no image work), web 10 / 12 | 91 | 161 |
| **Total** | **511** | **708** |
| Left for page cache and headroom | 325 | **128** |

Proposed limits for Hisaab:
- `db` 128m (`shared_buffers=24MB`, `work_mem=2MB`, 20 connections, no parallel query, no JIT);
- `api` 192m (`--max-old-space-size=96`; no sharp, so no native decode on top);
- `web` 32m.

Limits are caps, not reservations, so all the limits together may exceed RAM. What protects the host is that real use stays well under them, which CI checks.

**If the measured busy total doesn't fit** (less than about 80 MiB left), in this order:
1. Lower Hisaab's heap cap to 64 MiB and Postgres `shared_buffers` to 16 MB. Free; costs some speed.
2. One shared Postgres container with a database and role per app. Saves about 25 to 30 MiB idle, but couples the two apps' databases, upgrades and backups.
3. A bigger VM. B2als v2 (4 GiB) is not in the free 750 hours, so every hour up is billed. The price comes from the Retail Prices API at that time.

The 2 GB swap means an overrun first slows the VM rather than killing it. A container over its own limit is OOM-killed and restarted alone; the other app keeps running.

## 5. Manual steps (yours)

1. **DNS:** nothing by hand. `hisaab-up.sh` creates and updates the `hisaab.dhruvgoyal.tech` A record through Cloudflare's API, the same way as Chitthi. It needs a Cloudflare API token (Zone Read and DNS Edit on `dhruvgoyal.tech`). You can reuse Chitthi's token value or make a new one.
2. **Remove the old CNAME** for the legacy subdomain in Cloudflare (it carries the trademarked name).
3. **Production OAuth apps** (separate from the dev ones):
   - **Google:** a new OAuth client in a project whose consent screen has the homepage `https://hisaab.dhruvgoyal.tech`, the privacy and terms URLs (`/privacy`, `/terms`), scopes `openid email profile`, publishing status "In production". Redirect URI `https://hisaab.dhruvgoyal.tech/api/auth/google/callback`.
   - **GitHub:** a new OAuth app with homepage `https://hisaab.dhruvgoyal.tech` and callback `https://hisaab.dhruvgoyal.tech/api/auth/github/callback`.
   - `setup.sh secrets` asks for the four values (hidden input, into Key Vault).
4. **R2:** a bucket `hisaab-backups` with a 30-day bucket lock, and an R2 API token limited to that bucket (Object Read and Write).
5. **healthchecks.io:** checks `hisaab-backup` (daily) and `hisaab-drill` (monthly), plus an API key for pause and resume (or Chitthi's project key).
6. **UptimeRobot:** an HTTPS monitor on `https://hisaab.dhruvgoyal.tech/api/health` (the Main API key you already have works).
7. **GitHub:**
   - Environment `production`, with you as required reviewer and deploys from `main` only.
   - Environment secrets: the Azure client, tenant and subscription ids, printed by `setup.sh summary`.
   - The repository variable `DEPLOY_ENABLED=true`, set last.
8. **Run once in Cloud Shell:** `setup.sh app` (and `secrets`); then I run `selftest` and the first deploy.

## 6. `hisaab-up.sh` and `hisaab-down.sh`

These follow your standing rule and Chitthi's scripts step by step.

**`hisaab-up.sh`** (target: under 10 minutes from fully down):
1. **Preflight:** `az`, `jq` and `curl` installed; signed in; the subscription holding `apps-host` picked automatically; its state read from ARM (not the CLI cache). The subscription must be Enabled.
2. **Host:** `host-up.sh app=hisaab` writes the tag `app-hisaab: up`; it creates the IPv4 if missing and starts the VM if needed.
3. **DNS:** the Cloudflare A record, DNS only, TTL 60.
4. **Health:** on the new IP, with the certificate checked against the name. Then 1.1.1.1 must answer the new IP. Then the domain itself, through real DNS. The certificate must have at least 14 days left.
5. **Monitors resumed:** healthchecks `hisaab-*` and UptimeRobot.
6. **One real request to each dependency:**
   - Google's authorize page accepts our client id and callback.
   - GitHub's authorize page answers for our client id.
   - Let's Encrypt's directory answers.
   - From the VM, with its own identity: Key Vault, Blob and R2, via `backup.sh check`.
7. **The box:** URL, fallback (a hosts-file line with the IP), cost per hour, "run `bash hisaab-down.sh` when done".

**`hisaab-down.sh`:**
1. A final backup (refuses to stop if it fails, unless `--skip-backup`).
2. Monitors paused.
3. DNS parked at 192.0.2.1.
4. Tag `app-hisaab: down`.
5. If Chitthi is up, stop here (Section 2). Otherwise `host-down.sh app=hisaab`: alerts off, deallocate, IPv4 deleted.
6. The audit of the whole subscription, which prints STILL BILLING and exits non-zero if anything bills while idle.

Both scripts are idempotent and retry transient ARM errors (429, 5xx, "in progress"). They use REST rather than version-dependent `az` subcommands. They are written for Git Bash with `set -euo pipefail`, `MSYS_NO_PATHCONV=1`, `cygpath` and no MSYS temp paths. Secrets come from Key Vault into variables only and go to curl on stdin. **Images are built in CI (GitHub Actions) from the commit, never locally**, so no `.env` or private file can enter an image.

**The real cycle test (by me, once the manual steps are done):** up → a real request (dev-login-free: OAuth authorize checks plus `/api/health`) → down with a clean audit → up again, both with Chitthi down and with Chitthi up.

### Cost

At malaysiawest retail prices (Chitthi's MAINTENANCE.md, 2026-10-24, INR). **Hisaab adds no hourly cost while Chitthi is also up:** it shares the VM and the IPv4.

| | In the free 12 months | After them (disks as now) |
|---|---|---|
| Per hour while up (Hisaab alone, or both) | ₹0.48 (the IPv4) | ₹1.51 (VM ₹1.03 + IPv4 ₹0.48) |
| Per month if you forget down | ≈ ₹359 for the host (shared), plus Hisaab's storage | ≈ ₹3,069 (premium disks) |
| Per month while down | ≈ ₹1 to ₹9 for Hisaab's backup storage and Key Vault reads | the disks (shared, ≈ ₹1,960 premium) plus storage |

**Budget:** the existing `apps-host` budget (₹500 a month, alerts at 50, 80 and 100 % and the 100 % forecast) is at **subscription scope, so it already covers both apps**. No second budget is needed. It is an alert, not a cap. After the free 12 months, the disks alone exceed it whether the site is up or down, which is the decision Chitthi's MAINTENANCE.md already flags.

## 7. Build order

Each piece is a commit with CI green, in the order Chitthi went:
1. Production config and the production test (gap items 1, 2).
2. Images and the CI images job, with the page CSP (3, 4).
3. Production compose and the edge site file; the whole stack runs in CI behind the edge with the smoke workload and memory gate (5, 6, 11).
4. `/privacy` and `/terms` (12).
5. Host `deploy.sh` with rollback, tested in CI against a local edge (7).
6. `backup.sh` with selftest, drill and restore, tested in CI against fakes (8).
7. Vendored host scripts plus `hisaab-up.sh` and `hisaab-down.sh`, tested against `fake_az` (16).
8. Azure `setup.sh` app half and `deploy.yml` (9, 10).
9. MAINTENANCE.md (17).

Then your manual steps, then the cloud run: setup, selftest, first deploy, measurement on the real VM with both apps busy, and the up → down → up cycle.
