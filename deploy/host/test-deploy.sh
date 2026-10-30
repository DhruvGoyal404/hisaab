#!/usr/bin/env bash
# CI: exercises deploy/host/deploy.sh on a runner, with the images CI just built, secrets from
# throwaway files and the edge's internal CA. A second app's site file sits next to Hisaab's the
# whole time, and must come out byte-identical and still served, as must the edge's own files.
#   1. deploy (first release: nothing to roll back to). With HISAAB_TEST_GITHUB_TOKEN (CI's own
#      token), it fetches its files through the GitHub API and signs in to ghcr.io, as on the VM
#   2. the same release again (converges, keeps the rollback point, rotates both DB passwords)
#   3. a release whose API exits at once: must fail, roll itself back, previous release serving
#   4. a release whose site file is broken: must fail before changing anything
#   5. an explicit rollback after a good second release
#   6. backups: two nightly runs (append-only; the disk warning), a restore drill that passes, a
#      backup key rotation (drill and restore read both keys), a real restore (from Azure, then
#      from R2) that keeps the database's append-only rule, a tampered dump that the drill
#      catches, and a re-deploy that finds the timers and a fresh backup
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
secrets=$(mktemp -d)
ca=/data/edge/caddy/caddy/pki/authorities/local/root.crt
sha=${GITHUB_SHA:-0000000000000000000000000000000000000000}
fail() { echo "FAIL: $*" >&2; exit 1; }

openssl rand -hex 24 > "$secrets/hisaab-postgres-password"
openssl rand -hex 24 > "$secrets/hisaab-api-db-password"
for name in google-client-id google-client-secret github-client-id github-client-secret; do
  echo "ci-$name" > "$secrets/hisaab-$name"
done

hooks=(HISAAB_TEST_CONFIG_DIR="$repo" HISAAB_TEST_SECRETS_DIR="$secrets" HISAAB_TEST_CACERT="$ca")
token=()
[[ -n ${HISAAB_TEST_GITHUB_TOKEN:-} ]] && token=(HISAAB_GITHUB_TOKEN="$HISAAB_TEST_GITHUB_TOKEN")
extra=() # set for one release at a time
run() { sudo env "${hooks[@]}" "$repo/deploy/host/deploy.sh" "$@"; }
release() { # <api tag> [config dir]
  sudo env "${hooks[@]}" "${extra[@]}" ${2:+HISAAB_TEST_CONFIG_DIR="$2"} "$repo/deploy/host/deploy.sh" deploy \
    "sha=$sha" vault=ci-vault "api=hisaab-api:$1" migrate=hisaab-migrate:ci web=hisaab-web:ci storage=cistorage container=hisaab-backups r2_bucket=hisaab-backups
}
current_api() { sudo grep -h '^HISAAB_API_IMAGE=' /srv/hisaab/.env | cut -d= -f2-; }
edge_files() { sudo sha256sum /srv/edge/sites/other.caddy /srv/edge/Caddyfile /srv/edge/compose.yaml /srv/edge/.env; }
other_site() { sudo curl -fsS --max-time 5 --cacert "$ca" --resolve other.example.test:443:127.0.0.1 https://other.example.test/; }

# The folders Chitthi's bootstrap makes on the VM, the edge the way the host installs it (deploy/host/
# edge.sh is vendored from Chitthi and reads CHITTHI_*), then a second app's site file and its reload.
sudo install -d -m 0755 /srv/edge /srv/edge/sites /data /data/edge
sudo install -d -m 0700 -o 10002 -g 10002 /data/edge/caddy
sudo env CHITTHI_TEST_CONFIG_DIR="$repo" "$repo/deploy/host/edge.sh" "sha=$sha" acme_email=ci@example.com acme_ca=local
printf 'other.example.test {\n\trespond "the other app"\n}\n' | sudo tee /srv/edge/sites/other.caddy >/dev/null
sudo docker compose -p edge --project-directory /srv/edge exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
for _ in $(seq 1 20); do [[ $(other_site 2>/dev/null) == 'the other app' ]] && break; sleep 0.5; done
[[ $(other_site) == 'the other app' ]] || fail "the dummy second site is not served"
before=$(edge_files)
echo "ok   0. edge installed; a second app's site file is served next to where Hisaab's will go"

extra=("${token[@]}")
out=$(release ci) || { echo "$out"; fail "the first deploy failed"; }
extra=()
echo "$out"
if [[ ${#token[@]} -gt 0 ]]; then
  grep -qF 'configuration fetched through the GitHub API' <<<"$out" || fail "the deploy did not fetch through the API"
  grep -qF 'signed in to ghcr.io' <<<"$out" || fail "the deploy did not sign in to the registry"
  echo "ok   1. first deploy, its files fetched through the GitHub API with a short-lived token, signed in to ghcr.io"
else
  echo "ok   1. first deploy (no token: local files)"
fi
# Both database passwords rotated in "Key Vault" first: the migrations log in over TCP as the owner
# and the API's health includes its database, so success means both new passwords took effect.
openssl rand -hex 24 > "$secrets/hisaab-postgres-password"
openssl rand -hex 24 > "$secrets/hisaab-api-db-password"
release ci
[[ $(current_api) == hisaab-api:ci ]] || fail "re-deploy changed the release"
sudo grep -qF "$(cat "$secrets/hisaab-postgres-password")" /srv/hisaab/migrate.env || fail "the rotated owner password was not written"
echo "ok   2. re-deploy of the same release, with both database passwords rotated"

docker build -q -t hisaab-api:broken - >/dev/null <<'EOF'
FROM hisaab-api:ci
CMD ["node", "-e", "console.error('deliberately broken'); process.exit(1)"]
EOF
if release broken; then fail "a deploy whose API can't start reported success"; fi
[[ $(current_api) == hisaab-api:ci ]] || fail "after the failed deploy the API is $(current_api), not the previous release"
run smoke >/dev/null || fail "the rolled-back release does not pass the smoke test"
echo "ok   3. a broken API rolled itself back, and the previous release serves"

broken=$(mktemp -d)
cp -r "$repo/deploy" "$broken/"
printf '\nthis is { not a Caddyfile\n' >> "$broken/deploy/edge/hisaab.caddy"
site_before=$(sudo sha256sum /srv/edge/sites/hisaab.caddy)
docker tag hisaab-api:ci hisaab-api:untouched
if release untouched "$broken" 2>&1 | tee "$broken/deploy.log"; then fail "a deploy with a broken site file reported success"; fi
grep -q 'does not validate with the edge' "$broken/deploy.log" || fail "a broken site file got past the check before the switch"
if grep -q '^deploy: app up' "$broken/deploy.log"; then fail "a deploy with a broken site file switched the app"; fi
[[ $(sudo sha256sum /srv/edge/sites/hisaab.caddy) == "$site_before" ]] || fail "a broken site file was installed"
[[ $(current_api) == hisaab-api:ci ]] || fail "a deploy with a broken site file switched the release"
run smoke >/dev/null || fail "Hisaab stopped passing the smoke test after a broken site file"
echo "ok   4. a broken site file stopped the deploy before anything changed"

docker tag hisaab-api:ci hisaab-api:second
release second
[[ $(current_api) == hisaab-api:second ]] || fail "the second release is not current"
run rollback
[[ $(current_api) == hisaab-api:ci ]] || fail "rollback did not restore the previous release"
echo "ok   5. explicit rollback to the previous release"

# --- 6. Backups, with local folders standing in for Azure Blob and R2.
bt=$(mktemp -d)
mkdir -p "$bt/secrets"
age-keygen -o "$bt/secrets/hisaab-backup-age-identity" 2>/dev/null
age-keygen -y "$bt/secrets/hisaab-backup-age-identity" > "$bt/secrets/hisaab-backup-age-recipient"
backup() { sudo env HISAAB_BACKUP_TEST_DIR="$bt" /srv/hisaab/bin/backup.sh "$@"; }
db() { sudo docker compose -p hisaab --project-directory /srv/hisaab exec -T db psql -X -q -At -v ON_ERROR_STOP=1 -U hisaab -d hisaab; }

db <<<"INSERT INTO users (display_name) VALUES ('Backup probe')"
backup run
sleep 1
out=$(sudo env HISAAB_BACKUP_TEST_DIR="$bt" HISAAB_BACKUP_DISK_WARN_PCT=0 /srv/hisaab/bin/backup.sh run)
echo "$out"
grep -q 'WARNING: /data is [0-9]*% full' <<<"$out" || fail "the nightly run did not warn about the disk at its threshold"
dumps=$(sudo find "$bt/azure/db" -name '*.dump.age' | wc -l)
[[ $dumps -eq 2 ]] || fail "two backups should leave two dumps, found $dumps"
[[ $(sudo find "$bt/azure/manifests" -name '*.json' | wc -l) -eq 2 ]] || fail "two backups should leave two manifests"
[[ $(sudo find "$bt/r2/db" -name '*.dump.age' | wc -l) -eq 2 ]] || fail "the R2 copy is incomplete"
if sudo grep -q 'Backup probe' "$(sudo find "$bt/azure/db" -name '*.dump.age' | head -n 1)"; then fail "the dump is not encrypted"; fi
echo "ok   6a. two nightly backups: two dumps and manifests, R2 in step, dumps encrypted"

backup drill
echo "ok   6b. restore drill: checksums, decryption, restore, counts, schema version, R2 copy"

# Key rotation: the old private key becomes -previous, a new pair takes over.
newest_before=$(sudo find "$bt/azure/manifests" -name '*.json' | sort | tail -n 1)
sudo mv "$bt/secrets/hisaab-backup-age-identity" "$bt/secrets/hisaab-backup-age-identity-previous"
age-keygen -o "$bt/secrets/hisaab-backup-age-identity" 2>/dev/null
age-keygen -y "$bt/secrets/hisaab-backup-age-identity" > "$bt/secrets/hisaab-backup-age-recipient"
sleep 1
backup run >/dev/null
backup drill
echo "ok   6c. after a key rotation, the drill reads the new dump"

# A real restore: a table appears that the backup never had, and the old-key dump must still open.
db <<<'CREATE TABLE written_after_the_backup (x int)'
if backup restore 2>/dev/null; then fail "a restore ran without confirm="; fi
backup restore confirm=hisaab.dhruvgoyal.tech
[[ $(db <<<"SELECT count(*) FROM pg_tables WHERE tablename = 'written_after_the_backup'") == 0 ]] || fail "the restore did not replace the database"
[[ $(db <<<"SELECT count(*) FROM users WHERE display_name = 'Backup probe'") == 1 ]] || fail "the restored database lacks the probe"
sudo find /data/hisaab/pre-deploy -name 'hisaab-pre-restore-*.dump' | grep -q . || fail "the restore kept no copy of the database it replaced"
# From the catalog: this database has no activity rows for a row trigger to fire on.
append_only=$(db <<<"SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'activity_log'::regclass AND tgfoid = 'forbid_mutation'::regproc AND tgenabled = 'O'),
  has_table_privilege('hisaab_app', 'activity_log', 'UPDATE') OR has_table_privilege('hisaab_app', 'activity_log', 'DELETE')")
[[ $append_only == '2|f' ]] || fail "activity_log lost its append-only rule in the restore: $append_only"
run smoke >/dev/null || fail "the site does not pass the smoke test after the restore"
backup restore confirm=hisaab.dhruvgoyal.tech "manifest=${newest_before#"$bt/azure/"}" from=r2 >/dev/null
run smoke >/dev/null || fail "the site does not pass the smoke test after the restore from R2"
echo "ok   6d. restore: refused without confirm=; database replaced (old one kept), activity log still append-only, site healthy; again from R2 with an old-key dump"

newest=$(sudo find "$bt/azure/db" -name '*.dump.age' | sort | tail -n 1)
echo tampered | sudo tee -a "$newest" >/dev/null
if backup drill 2>/dev/null; then fail "the drill passed on a tampered dump"; fi
echo "ok   6e. the drill catches a tampered dump"

release ci | tee "$bt/deploy.log"
grep -q 'backups: timers active, last backup 0 h ago' "$bt/deploy.log" || fail "the deploy did not confirm the timers and a fresh backup"
echo "ok   6f. a deploy asserts both timers and the fresh backup"

[[ $(edge_files) == "$before" ]] || { diff <(echo "$before") <(edge_files) >&2; fail "Hisaab's deploys changed a file that isn't theirs"; }
[[ $(other_site) == 'the other app' ]] || fail "the second app's site stopped being served"
echo "ok   the second app's site file, the main Caddyfile and the edge's compose/.env are byte-identical, and the other site still answers"

echo "--- deploys.log"
sudo cat /srv/hisaab/deploys.log
echo "deploy tests passed"
