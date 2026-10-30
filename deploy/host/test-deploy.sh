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
    "sha=$sha" vault=ci-vault "api=hisaab-api:$1" migrate=hisaab-migrate:ci web=hisaab-web:ci
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

[[ $(edge_files) == "$before" ]] || { diff <(echo "$before") <(edge_files) >&2; fail "Hisaab's deploys changed a file that isn't theirs"; }
[[ $(other_site) == 'the other app' ]] || fail "the second app's site stopped being served"
echo "ok   the second app's site file, the main Caddyfile and the edge's compose/.env are byte-identical, and the other site still answers"

echo "--- deploys.log"
sudo cat /srv/hisaab/deploys.log
echo "deploy tests passed"
