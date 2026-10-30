# Running Hisaab in production

Hisaab shares the Azure VM `apps-vm` with Chitthi. The site is normally down: bring it up when you need it, and take it down afterwards. The host itself (the VM, its network, the edge Caddy, the alerts, the budget) belongs to [Chitthi's MAINTENANCE.md](https://github.com/DhruvGoyal404/chitthi/blob/main/docs/MAINTENANCE.md). This page covers Hisaab's half.

## Layout

| Where | What |
|---|---|
| `/srv/hisaab` on the VM | `compose.yaml`, env files (root only), `.env.previous` for rollback, `deploys.log`, `bin/backup.sh` |
| `/data/hisaab` on the data disk | `pg/` (Postgres, uid 10021), `pre-deploy/` (the last 5 dumps), `backup-state/` |
| `/srv/edge/sites/hisaab.caddy` | Hisaab's site file, the only thing it writes on the edge |
| Resource group `hisaab` | Key Vault `hisaab-kv-<sfx>`, ops vault `hisaab-ops-<sfx>` (the VM has no access), storage `hisaabbk<sfx>`, identity `hisaab-deploy` |
| Cloudflare R2 | Bucket `hisaab-backups`, the second copy of every backup |

Uids: 10020 API and migrate, 10021 Postgres, 10022 web (inside the image). Loopback ports: API 8081, web 5174.

Files copied from Chitthi are listed in [deploy/VENDORED.md](../deploy/VENDORED.md), and CI fails if they drift from the pinned commit.

## Going live (once)

Everything here is yours, except where it says otherwise.

1. **Cloudflare:** delete the old CNAME for the previous subdomain (the plan names it). Create an API token with Zone Read and DNS Edit on `dhruvgoyal.tech`.
2. **Google:** a new OAuth client. Consent screen homepage `https://hisaab.dhruvgoyal.tech`, privacy `/privacy`, terms `/terms`, scopes `openid email profile`, status "In production". Redirect URI `https://hisaab.dhruvgoyal.tech/api/auth/google/callback`.
3. **GitHub:** a new OAuth app, homepage as above, callback `https://hisaab.dhruvgoyal.tech/api/auth/github/callback`.
4. **R2:** bucket `hisaab-backups`. A bucket lock rule on the whole bucket for 30 days. Lifecycle rules deleting `db/`, `manifests/` and `selftest/` after 35 days. An API token limited to that bucket, Object Read and Write.
5. **healthchecks.io:** checks `hisaab-backup` (daily) and `hisaab-drill` (monthly), and a read-write API key for that project.
6. **UptimeRobot:** an HTTPS monitor on `https://hisaab.dhruvgoyal.tech/api/health`.
7. **Azure Cloud Shell:** `git clone https://github.com/DhruvGoyal404/hisaab && cd hisaab`, then `bash deploy/azure/setup.sh app`, then `bash deploy/azure/setup.sh secrets`. The second asks for the values above, hidden, and generates the database passwords and the backup keys. Keep a copy of the backup private key in a password manager: without it no backup can be read.
8. **GitHub repo settings:** environment `production` with you as required reviewer, deploys from `main` only. Add the secrets and variables that `bash deploy/azure/setup.sh summary` prints. Set the repository variable `DEPLOY_ENABLED=true` last.
9. **First deploy:** `bash hisaab-up.sh` starts the VM and sets DNS, then stops at the health check because nothing is deployed yet. Run Actions > Deploy > Run workflow and approve it. Then `bash hisaab-up.sh` again.
10. **Prove the backups:** `bash deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest`, then `backup.sh run`, then `backup.sh drill`.

## Up and down

```sh
bash hisaab-up.sh      # fully down to live in about 5-10 minutes
bash hisaab-down.sh    # stops what bills; ends with an audit
```

`hisaab-up.sh` brings the host up, points DNS at the new address, waits for health and then the domain, resumes the monitors, and makes one real request to Google, GitHub, Let's Encrypt, Key Vault, Azure Blob and R2.

`hisaab-down.sh` takes a final backup, pauses the monitors and parks DNS at 192.0.2.1. It then takes the host down and runs the audit, which prints `STILL BILLING` and exits non-zero if anything bills. `--skip-backup` skips the backup, when the VM can't take one.

**With Chitthi on the same VM.** Each app has a VM tag: `app-<name>` is `up` or `down`.

- If Chitthi is up, `hisaab-down.sh` does Hisaab's steps, marks it down and leaves the VM running, because the VM is what Chitthi is using. It says so, and `bash chitthi-down.sh` then stops the costs. Hisaab's containers keep running on the VM, unreachable.
- If you want both down, order doesn't matter: the second down script takes the host.
- If the VM came up for Chitthi, `bash hisaab-up.sh --app-only` brings Hisaab back without touching the host.

## Deploy and rollback

CI builds and tests every push to `main`. If it passes and `DEPLOY_ENABLED` is `true`, the Deploy workflow builds the images, pushes them to GHCR and waits for your approval. The VM must be up, or the run fails with "run chitthi-up.sh first": bring it up with `hisaab-up.sh`, then re-run.

`deploy/host/deploy.sh` runs on the VM through managed Run Command. It validates the site file against the whole edge config, writes each container's env file from Key Vault, pulls by digest and dumps the database. It then migrates, starts the new release, installs the site file under the edge lock and smoke-tests. If anything fails after the switch, the previous release comes back on its own and the deploy still exits non-zero.

**Roll back by hand:** Actions > Deploy > Run workflow > `rollback`. This restores images only, never the schema. Migrations are forward-only, so each one must keep the previous release working: expand now, contract in a later release.

**Rehearse:** Run workflow > `rehearse-rollback` deploys a deliberately broken API and proves it rolls itself back.

## Backups

- **Nightly, 02:20 IST** (`hisaab-backup.timer`; missed runs happen at the next boot): `pg_dump`, encrypted with age to a public key, to Azure Blob and then R2.
- **Monthly drill** (`hisaab-restore-drill.timer`): restores the newest backup into a scratch database and checks its checksums, counts, schema version and the R2 copy.
- **Append-only:** the VM can create but not overwrite or delete, in both stores. `backup.sh selftest` proves it. In Azure a duplicate create gets 403 or 409. In R2 the bucket lock answers 409. Both mean "refused", not "failed".
- **Retention:** lifecycle rules delete after 35 days, in both stores. The privacy page states this, so change them together.

Failures reach healthchecks.io with a one-line reason. The nightly run also turns that check red if `/data` is over 80 % full, or if the certificate has under 14 days left.

**Restore** (replaces the live database, and keeps a copy of what it replaced in `/data/hisaab/pre-deploy`):

```sh
bash deploy/azure/run-on-vm.sh deploy/host/backup.sh restore confirm=hisaab.dhruvgoyal.tech
# or: ... manifest=manifests/<UTC>.json from=r2
```

On a new data disk, run one deploy first. Roles live outside the database, so the dump needs the migrations to have created them.

## Secret rotation

`bash deploy/azure/setup.sh rotate name=<secret>`. Database passwords and OAuth secrets take effect at the next deploy. Revoke an old OAuth secret at its provider afterwards. For the backup key, keep the old private key (saved as `-previous`) for 35 days, until nothing encrypted to it remains.

## Incidents

Start with `bash deploy/azure/run-on-vm.sh deploy/host/status.sh`: memory, disk, recent API errors, backups, deploys, the certificate, containers and health.

| What you see | What to do |
|---|---|
| A backup alert | Read the reason on healthchecks.io. Run `backup.sh run` again. Check the R2 and Azure credentials with `backup.sh check`. |
| Health is `degraded` | Postgres is down or unreachable. Check `status.sh`, then roll back if a deploy caused it. |
| A container keeps restarting | Probably its memory limit. `docker inspect` shows `OOMKilled`; see "Memory" below. |
| The site answers an old address | DNS TTL is 60 s, but a local resolver may hold it. The up script's box prints a hosts-file line. |
| Sign-in fails | Check the callback URLs at the provider. `hisaab-up.sh` tests both clients on each run. |
| A dependency audit fails CI | `scripts/audit-gate.mjs` lists dated exceptions. When one expires, do the upgrade it names, under the 14-day rule. |

## Costs

Malaysia West retail prices in INR, from Chitthi's measurements of 2026-10-24.

| | First 12 months (free allowance) | After that |
|---|---|---|
| Per hour while up (Hisaab alone, or both apps) | ₹0.48 (the IPv4) | ₹1.51 (VM ₹1.03 + IPv4 ₹0.48) |
| Per month if you forget to run down | ≈ ₹359, shared, plus Hisaab's storage | ≈ ₹3,069 with premium disks |
| Per month while down | ≈ ₹1 to ₹9 for backup storage and Key Vault reads | the same, plus the shared disks, ≈ ₹1,960 for premium |

Hisaab adds no hourly cost while Chitthi is also up.

**Budget:** `apps-host`, ₹500 a month at subscription scope, so it covers both apps despite its name. It emails at 50, 80 and 100 % and on the 100 % forecast. It is an alert, not a cap: nothing stops when it fires.

## Memory

Measured by CI on every push (`deploy/smoke/smoke.sh`): resident memory (anon + kernel + shmem) under a load of 4 users, 8 sockets and 100 expenses, on 2026-10-30.

| Container | Idle | Under load | Limit |
|---|---|---|---|
| db | 28 MiB | 46 MiB | 128 MiB |
| api | 29 MiB | 37 MiB | 192 MiB |
| web | 11 MiB | 11 MiB | 32 MiB |
| Hisaab total | 68 MiB | 94 MiB | |

The VM has 836 MiB. The OS uses about 297 MiB, Chitthi about 226 MiB busy, so with Hisaab's 94 MiB about 219 MiB stays free, before 2 GB of swap. These are CI numbers, not yet measured on the VM with both apps busy.

If a container overruns, it alone is killed and restarted. If the VM runs short, first lower the API's heap (`HISAAB_API_HEAP_MB`) and Postgres `shared_buffers` in `deploy/hisaab/compose.yaml`.
