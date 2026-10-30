#!/usr/bin/env bash
# Smoke-tests the production stack exactly as deploy/ defines it, and measures its memory:
#   deploy/smoke/smoke.sh <api-image> <migrate-image> <web-image>
#
# Brings up deploy/hisaab (with throwaway secrets) and the edge (deploy/edge, vendored from Chitthi,
# with Caddy's internal CA in place of Let's Encrypt), points hisaab.dhruvgoyal.tech at 127.0.0.1,
# checks the edge and the production refusals, runs deploy/smoke/workload.mjs through the edge, and
# prints each container's memory: idle, under the workload, and the peak.
#
# CI only: it needs Linux (host networking, cgroup v2 files), sudo (/etc/hosts, data-directory
# owners), free ports 80/443/8081/5174, and `npm ci` done (the workload uses socket.io-client).
# Everything it creates is removed on exit.
set -euo pipefail

api_image=$1 migrate_image=$2 web_image=$3
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
host=hisaab.dhruvgoyal.tech
work=$(mktemp -d)
samples=$work/samples
pids=()

fail() { echo "FAIL: $*" >&2; exit 1; }

cleanup() {
  set +e
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  (cd "$work/hisaab" && docker compose -p hisaab logs --no-color api > "$work/api.log" 2>&1)
  if [[ ${status:-1} -ne 0 && -f $work/api.log ]]; then echo "--- API log (last 60 lines)"; tail -n 60 "$work/api.log"; fi
  (cd "$work/edge" && docker compose -p edge down -v --remove-orphans) >/dev/null 2>&1
  (cd "$work/hisaab" && docker compose -p hisaab --profile migrate down -v --remove-orphans) >/dev/null 2>&1
  sudo sed -i "/ $host\$/d" /etc/hosts
  sudo rm -rf "$work"
}
trap 'status=$?; cleanup' EXIT

secret() { openssl rand -hex 24; }

# --- The app stack, from the committed files, with secrets the way the deploy script writes them.
owner_pw=$(secret) api_pw=$(secret)
mkdir -p "$work/hisaab" "$work/data/pg"
# Owned the way the deploy owns it on the VM: Postgres runs as 10021.
sudo chown 10021:10021 "$work/data/pg" && sudo chmod 0700 "$work/data/pg"
cp "$repo/deploy/hisaab/compose.yaml" "$work/hisaab/"
umask 077
printf 'HISAAB_API_IMAGE=%s\nHISAAB_MIGRATE_IMAGE=%s\nHISAAB_WEB_IMAGE=%s\nHISAAB_DATA=%s\n' \
  "$api_image" "$migrate_image" "$web_image" "$work/data" > "$work/hisaab/.env"
printf 'POSTGRES_PASSWORD=%s\n' "$owner_pw" > "$work/hisaab/db.env"
printf 'MIGRATE_DATABASE_URL=postgres://hisaab:%s@db:5432/hisaab?sslmode=disable\nDATABASE_URL=postgres://hisaab_api:%s@db:5432/hisaab?sslmode=disable\n' \
  "$owner_pw" "$api_pw" > "$work/hisaab/migrate.env"
printf 'DATABASE_URL=postgres://hisaab_api:%s@db:5432/hisaab?sslmode=disable\n' "$api_pw" > "$work/hisaab/api.env"
umask 022

cd "$work/hisaab"
docker compose -p hisaab config --quiet
docker compose -p hisaab up -d --wait db
docker compose -p hisaab run --rm migrate
docker compose -p hisaab up -d --wait api web
echo "ok   stack up: db, migrate, api, web"
# The heap cap the API really runs with (NODE_OPTIONS reaches every node process in the container).
heap_mb=$(docker compose -p hisaab exec -T api node -e \
  'console.log(Math.round(require("node:v8").getHeapStatistics().heap_size_limit / 1048576))')
(( heap_mb > 0 && heap_mb < 160 )) || fail "the API's V8 heap limit is ${heap_mb} MiB; NODE_OPTIONS did not apply"
echo "ok   API V8 heap limit: ${heap_mb} MiB"

# --- The edge, from the vendored files plus Hisaab's own site file, with the internal CA.
mkdir -p "$work/edge/sites" "$work/edge-data/caddy"
cp "$repo/deploy/edge/compose.yaml" "$repo/deploy/edge/Caddyfile" "$work/edge/"
cp "$repo/deploy/edge/hisaab.caddy" "$work/edge/sites/"
sudo chown 10002:10002 "$work/edge-data/caddy"
printf 'ACME_EMAIL=smoke@example.com\nEDGE_CA_OPTION=local_certs\nEDGE_DATA=%s\n' "$work/edge-data" > "$work/edge/.env"
echo "127.0.0.1 $host" | sudo tee -a /etc/hosts >/dev/null
(cd "$work/edge" && docker compose -p edge config --quiet && docker compose -p edge up -d --wait)
for _ in $(seq 1 40); do sudo test -s "$work/edge-data/caddy/caddy/pki/authorities/local/root.crt" && break; sleep 0.5; done
sudo install -m 0644 "$work/edge-data/caddy/caddy/pki/authorities/local/root.crt" "$work/root.crt"
for _ in $(seq 1 40); do curl -fsS --cacert "$work/root.crt" -o /dev/null "https://$host/api/health" 2>/dev/null && break; sleep 0.5; done
echo "ok   edge up: TLS for $host from the internal CA"

curl_edge() { curl -sS --cacert "$work/root.crt" "$@"; }

# --- The edge and the production refusals.
code=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/groups/x")
[[ $code == "308 https://$host/groups/x" ]] || fail "plain HTTP is not redirected to HTTPS: $code"
headers=$(curl_edge -D - -o /dev/null "https://$host/")
grep -qiF 'Strict-Transport-Security: max-age=31536000' <<<"$headers" || fail "no HSTS on the page"
grep -qi 'Strict-Transport-Security:.*includeSubDomains' <<<"$headers" && fail "HSTS covers other dhruvgoyal.tech hosts"
grep -qiF "frame-ancestors 'none'" <<<"$headers" || fail "the page lost its CSP through the edge"
grep -qi '^Server:' <<<"$headers" && fail "the edge announces its server"
headers=$(curl_edge -D - -o /dev/null "https://$host/api/health")
grep -qiF "Content-Security-Policy: default-src 'none'" <<<"$headers" || fail "the API lost its CSP through the edge"
grep -qiF 'Strict-Transport-Security: max-age=31536000' <<<"$headers" || fail "no HSTS on the API"
grep -qi 'Strict-Transport-Security:.*includeSubDomains' <<<"$headers" && fail "the API's HSTS covers other dhruvgoyal.tech hosts"
echo "ok   edge: HTTP→HTTPS, HSTS without includeSubDomains, CSPs intact, no Server header"

# The Origin allow-list guards every Engine.IO request; the session is checked at Socket.IO connect
# (the workload covers that: a socket without a session gets "unauthenticated").
code=$(curl_edge -o /dev/null -w '%{http_code}' -H "Origin: https://evil.example" "https://$host/api/socket.io/?EIO=4&transport=polling")
[[ $code == 403 ]] || fail "a Socket.IO handshake from a foreign Origin got $code, not 403"
code=$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "https://$host/api/auth/logout")
[[ $code == 403 ]] || fail "a POST without Origin got $code, not 403"
code=$(curl_edge -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://$host" -H 'Content-Type: application/json' -d '{"name":"x"}' "https://$host/api/dev/login")
[[ $code == 404 ]] || fail "the dev sign-in answered $code in production, not 404"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:5432/ 2>/dev/null || true)
[[ $code == 000 ]] || fail "Postgres is reachable from the host"
set +e
out=$(docker run --rm -e NODE_ENV=production -e DEV_LOGIN=true -e DATABASE_URL=postgres://u:p@db/x \
  -e PUBLIC_URL="https://$host" -e WEB_ORIGINS="https://$host" "$api_image" 2>&1)
code=$?
set -e
[[ $code -eq 1 && $out == *DEV_LOGIN* ]] || fail "the API started in production with DEV_LOGIN=true (exit $code)"
echo "ok   refusals: missing/foreign Origin (REST and Socket.IO), dev sign-in 404, DEV_LOGIN fatal, Postgres not on the host"

# --- Memory: cgroup v2 files of each container, sampled from the host every 250 ms.
containers=(hisaab-db-1 hisaab-api-1 hisaab-web-1 edge-caddy-1)
cgdir() {
  local id
  id=$(docker inspect -f '{{.Id}}' "$1")
  for d in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
    [[ -d $d ]] && { echo "$d"; return; }
  done
  fail "no cgroup directory for $1"
}
declare -A cg
for c in "${containers[@]}"; do cg[$c]=$(cgdir "$c"); done
phase_file=$work/phase
sample() {
  while :; do
    local phase
    phase=$(cat "$phase_file")
    for c in "${containers[@]}"; do
      awk -v p="$phase" -v c="$c" '$1=="anon"{a=$2} $1=="kernel"{k=$2} $1=="shmem"{s=$2} $1=="file"{f=$2}
        END{print p, c, a, k, s, f}' "${cg[$c]}/memory.stat"
    done >> "$samples"
    sleep 0.25
  done
}

echo idle > "$phase_file"
sleep 10 # let start-up allocations settle before the idle window
sample & pids+=($!)
sleep 10

echo load > "$phase_file"
node "$here/workload.mjs" seed "$work/tokens.json" \
  | docker compose -p hisaab exec -T db psql -q -v ON_ERROR_STOP=1 -U hisaab -d hisaab >/dev/null
API_BASE="https://$host" ORIGIN="https://$host" NODE_EXTRA_CA_CERTS="$work/root.crt" \
  node "$here/workload.mjs" run "$work/tokens.json"
sleep 2
kill "${pids[@]}" 2>/dev/null; pids=()

# resident = anon + kernel + shmem: what can't be dropped under pressure. Page cache ("file") can,
# and is left out.
echo
echo "MEMORY (MiB)   resident = anon + kernel + shmem; peak = cgroup memory.peak since start (incl. page cache)"
printf '%-22s %10s %10s %10s %10s %10s\n' container idle load-max anon-max peak limit
for c in "${containers[@]}"; do
  read -r idle load anon < <(awk -v c="$c" '$2==c { r=$3+$4+$5
      if ($1=="idle" && r>i) i=r; if ($1=="load" && r>l) l=r; if ($3>a) a=$3 }
    END { printf "%.1f %.1f %.1f\n", i/1048576, l/1048576, a/1048576 }' "$samples")
  peak=$(awk '{ printf "%.1f", $1/1048576 }' "${cg[$c]}/memory.peak")
  limit=$(awk '{ if ($1=="max") print "none"; else printf "%.0f", $1/1048576 }' "${cg[$c]}/memory.max")
  printf '%-22s %10s %10s %10s %10s %10s\n' "$c" "$idle" "$load" "$anon" "$peak" "$limit"
done
for c in "${containers[@]}"; do
  oom=$(awk '$1=="oom_kill"{print $2}' "${cg[$c]}/memory.events")
  [[ $oom == 0 ]] || fail "$c was OOM-killed $oom time(s) during the smoke test"
done
echo "ok   no container hit its memory limit"

# Each Hisaab container must stay clear of its limit under load.
for c in hisaab-db-1 hisaab-api-1 hisaab-web-1; do
  max=$(awk -v c="$c" '$2==c && $1=="load" { r=$3+$4+$5; if (r>m) m=r } END { printf "%.0f", m/1048576 }' "$samples")
  limit=$(awk '{ printf "%.0f", $1/1048576 }' "${cg[$c]}/memory.max")
  (( max * 10 < limit * 9 )) || fail "$c came within 10 % of its memory limit (${max} of ${limit} MiB)"
done
echo "ok   every Hisaab container stays under 90 % of its memory limit"

curl_edge -fsS -o /dev/null "https://$host/api/health" || fail "the API is not healthy after the workload"
echo "smoke test passed"
