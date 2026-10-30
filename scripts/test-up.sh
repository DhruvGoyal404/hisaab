#!/usr/bin/env bash
# Runs hisaab-up.sh against stand-ins for az, curl, openssl and sleep: the preflight, a host that is
# fully down, a host Chitthi already has up, --app-only, the DNS step, and each way it can stop.
# The stand-ins keep state in a call log, so a PIP exists once it was PUT, a VM runs once started.
# shellcheck disable=SC2015 # "A && B || fail": fail exits, and is meant to run if either is false
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
bin=$(mktemp -d)
trap 'rm -rf -- "$bin"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -z ${out:-} ]] || echo "$out" >&2; exit 1; }
IP=203.0.113.7 # the address the fake Azure hands out

cat > "$bin/az" <<'EOF'
#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
wrote() { grep -qF -- "$1" "$FAKE_LOG"; }
case "$1 $2" in
  'account show')
    [[ -n ${FAKE_LOGGED_OUT:-} ]] && ! wrote 'az login' && exit 1
    [[ $* == *--query* ]] && echo 'Fake sub'
    exit 0 ;;
  'login --output') exit 0 ;;
  'account list')
    if [[ $* == *"name=='Azure for Students'"* ]]; then echo sub-students; else echo sub-other; fi
    exit 0 ;;
  'account set') exit 0 ;;
  'group exists')
    if [[ $* == *"--subscription ${FAKE_HOST_SUB:-sub-students}"* ]]; then echo true; else echo false; fi
    exit 0 ;;
  'keyvault secret')
    [[ $* == *hisaab-*-client-id* ]] && echo fake-client-id || echo fake-secret-value
    exit 0 ;;
  'vm get-instance-view') printf 'malaysiawest\nPowerState/running\n'; exit 0 ;;
  'vm run-command')
    case $3 in
      show) printf '{"instanceView":{"output":"backup check","exitCode":%s}}\n' "${FAKE_BACKUP_RC:-0}" ;;
    esac
    exit 0 ;;
esac
method='' url=''
for ((i = 1; i <= $#; i++)); do
  j=$((i + 1))
  [[ ${!i} == --method ]] && method=${!j}
  [[ ${!i} == --url ]] && url=${!j}
done
notfound() { echo 'ERROR: (NotFound) not there' >&2; exit 1; }
power=$FAKE_POWER
wrote '/start?' && power=running
pip=''
[[ -n ${FAKE_PIP:-} ]] && pip=1
wrote "put --url https://management.azure.com/subscriptions/$FAKE_SUB/resourceGroups/apps-host/providers/Microsoft.Network/publicIPAddresses/apps-vm-ip" && pip=1
nic_ip=''
[[ -n ${FAKE_PIP:-} ]] && nic_ip=',"publicIPAddress":{"id":"'$FAKE_PIP_ID'"}'
case "$method $url" in
  'patch '*/tags/default*) echo '{}' ;;
  'get '*'/subscriptions/'*'?api-version=2022-12-01') printf '{"state":"%s"}\n' "${FAKE_SUB_STATE:-Enabled}" ;;
  'get '*/virtualMachines/apps-vm\?*)
    printf '{"location":"malaysiawest","tags":%s,"properties":{"instanceView":{"statuses":[{"code":"ProvisioningState/succeeded"},{"code":"PowerState/%s"}]},"networkProfile":{"networkInterfaces":[{"id":"/nic"}]}}}\n' "$FAKE_TAGS" "$power" ;;
  'put '*/publicIPAddresses/*) echo '{}' ;;
  'get '*/publicIPAddresses/*)
    [[ -n $pip ]] || notfound
    printf '{"properties":{"provisioningState":"Succeeded","ipAddress":"%s"}}\n' "$FAKE_IP" ;;
  'get '*/nic\?*) printf '{"location":"malaysiawest","tags":{},"properties":{"provisioningState":"Succeeded","ipConfigurations":[{"properties":{"primary":true%s}}]}}\n' "$nic_ip" ;;
  'put '*/nic\?*) echo '{}' ;;
  'post '*/start\?*) echo '{}' ;;
  'get '*/metricAlerts/*|'get '*/activityLogAlerts/*) echo '{"properties":{"enabled":false}}' ;;
  'patch '*/metricAlerts/*|'patch '*/activityLogAlerts/*) echo '{}' ;;
  *) echo "the fake has no answer for: $method $url" >&2; exit 1 ;;
esac
EOF

cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
[[ $* == *'-K -'* ]] && cat >> "$FAKE_LOG.stdin" # the secrets: never in the argv above
case "$*" in
  *'/api/health'*) healthy='{"status":"ok","db":"ok"}'; printf '%s' "${FAKE_HEALTH-$healthy}" ;;
  *cloudflare-dns.com*) printf '{"Answer":[{"type":5,"data":"x."},{"type":1,"data":"%s"}]}\n' "$FAKE_IP" ;;
  *api.cloudflare.com*'/zones?name='*)
    [[ -n ${FAKE_NO_ZONE:-} ]] && { echo '{"result":[]}'; exit 0; }
    echo '{"result":[{"id":"zone1"}]}' ;;
  *'-X PATCH'*dns_records*|*'-X POST'*dns_records*) [[ -z ${FAKE_DNS_READONLY:-} ]] || exit 22 ;;
  *dns_records*) printf '{"result":%s}\n' "$FAKE_RECORDS" ;;
  *healthchecks.io/api/v3/checks/)
    echo '{"checks":[{"name":"hisaab-backup","status":"paused","update_url":"https://healthchecks.io/api/v3/checks/h1"},
      {"name":"chitthi-backup","status":"paused","update_url":"https://healthchecks.io/api/v3/checks/c1"}]}' ;;
  *healthchecks.io*) ;;
  *uptimerobot.com/v2/getMonitors*) echo '{"stat":"ok","monitors":[{"id":1,"friendly_name":"hisaab","status":0}]}' ;;
  *uptimerobot.com/v2/editMonitor*) echo '{"stat":"ok"}' ;;
  *accounts.google.com*) printf '%s' "${FAKE_GOOGLE-302 https://accounts.google.com/signin}" ;;
  *github.com/login/oauth*) printf '302 https://github.com/login?client_id=x' ;;
  *letsencrypt.org*) ;;
  *) echo "the fake has no answer for: curl $*" >&2; exit 7 ;;
esac
EOF

cat > "$bin/openssl" <<'EOF'
#!/usr/bin/env bash
case $1 in
  s_client) echo certificate ;;
  x509) cat >/dev/null; echo "notAfter=$(date -u -d '+60 days' '+%b %d %H:%M:%S %Y GMT')" ;;
esac
EOF
printf '#!/bin/sh\n' > "$bin/sleep"
chmod +x "$bin/az" "$bin/curl" "$bin/openssl" "$bin/sleep"

run() { # <tags JSON> [hisaab-up.sh args...]: sets $out and $code; settings come from FAKE_* in the env
  export FAKE_LOG=$bin/log FAKE_TAGS=$1 FAKE_POWER=${FAKE_POWER:-running} FAKE_IP=$IP
  export FAKE_SUB=${FAKE_HOST_SUB:-sub-students} FAKE_RECORDS=${FAKE_RECORDS:-'[{"id":"r1","content":"192.0.2.1","proxied":false}]'}
  export FAKE_PIP_ID=/subscriptions/$FAKE_SUB/resourceGroups/apps-host/providers/Microsoft.Network/publicIPAddresses/apps-vm-ip
  shift
  : > "$FAKE_LOG"
  : > "$FAKE_LOG.stdin"
  set +e
  out=$(PATH=$bin:$PATH ARM_RETRY_SECONDS=0 bash "$repo/hisaab-up.sh" "$@" 2>&1)
  code=$?
  set -e
}
called() { grep -qF -- "$1" "$FAKE_LOG"; }
said() { grep -qF -- "$1" <<<"$out"; }
wrote() { grep -E '^az rest --method (put|patch|post) ' "$FAKE_LOG" | grep -vF 'CostManagement' || true; }
dns_writes() { grep -E '^curl .*-X (PATCH|POST) .*dns_records' "$FAKE_LOG" || true; }
tagged_up() { grep -F 'tags/default' "$FAKE_LOG" | grep -qF '"app-hisaab":"up"'; }
no_secrets_in_argv() {
  ! grep -qF fake-secret-value "$FAKE_LOG" || fail "$1: a secret reached a command line"
  ! said fake-secret-value || fail "$1: a secret was printed"
}
fake_up_host() { export FAKE_PIP=1 FAKE_POWER=running; }
fake_down_host() { export FAKE_PIP='' FAKE_POWER=deallocated; }

# -- Preflight ------------------------------------------------------------------------------------
# Only these tools on the PATH, less the one left out.
without() { # <tool to leave out>: runs hisaab-up.sh, sets $out and $code
  local tools t
  tools=$(mktemp -d "$bin/tools.XXXXXX")
  for t in dirname az jq curl tr; do
    [[ $t == "$1" ]] || ln -s "$(PATH=$bin:$PATH command -v "$t")" "$tools/$t"
  done
  set +e
  out=$(PATH=$tools "$(command -v bash)" "$repo/hisaab-up.sh" 2>&1)
  code=$?
  set -e
}
for tool in az jq curl; do
  without "$tool"
  [[ $code -ne 0 ]] && said "'$tool' is not installed" || fail "with no $tool it exited $code"
done
out=''
echo "ok   preflight: a missing tool stops it"

fake_up_host
export FAKE_LOGGED_OUT=1
run '{"app-hisaab":"down"}'
unset FAKE_LOGGED_OUT
[[ $code -eq 0 ]] && called 'az login --output none' || fail "signed out: exit $code, or it never signed in"
echo "ok   preflight: signs in when signed out"

export FAKE_HOST_SUB=sub-other
run '{"app-hisaab":"down"}'
[[ $code -eq 0 ]] || fail "the host in the second subscription: exit $code"
called 'az account set --subscription sub-other' || fail "it did not pick the subscription holding apps-host"
echo "ok   preflight: picks the subscription that holds the host"

export FAKE_HOST_SUB=sub-nowhere
run '{"app-hisaab":"down"}'
unset FAKE_HOST_SUB
[[ $code -ne 0 ]] && said "holds resource group apps-host" || fail "no subscription holds the host: exit $code"
[[ -z $(wrote) ]] || fail "it wrote to Azure with no host found"
echo "ok   preflight: no subscription holds the host, nothing written"

fake_down_host
export FAKE_SUB_STATE=Disabled
run '{"app-hisaab":"down"}'
unset FAKE_SUB_STATE
[[ $code -ne 0 ]] && said "the subscription is 'Disabled'" || fail "a disabled subscription: exit $code"
[[ -z $(wrote) ]] || fail "it wrote to Azure on a disabled subscription"
echo "ok   preflight: a disabled subscription stops it before any write"

# -- Fully down -----------------------------------------------------------------------------------
fake_down_host
run '{"app-hisaab":"down","app-chitthi":"down"}'
[[ $code -eq 0 ]] || fail "from fully down: exit $code"
called "--method put --url https://management.azure.com/subscriptions/sub-students/resourceGroups/apps-host/providers/Microsoft.Network/publicIPAddresses/apps-vm-ip" \
  || fail "it created no IPv4"
called '/nic?' && grep -qF -- "--method put --url https://management.azure.com/nic?" "$FAKE_LOG" || fail "it did not attach the IPv4"
grep -qF '"publicIPAddress":{"id":"/subscriptions/sub-students/' "$FAKE_LOG" || fail "the NIC update carries no public IP"
called '/start?' || fail "it did not start the VM"
called '--method patch --url https://management.azure.com/subscriptions/sub-students/resourceGroups/apps-host/providers/Microsoft.Insights/metricAlerts/vm-unavailable' \
  || fail "it did not turn the alerts on"
tagged_up || fail "Hisaab was not marked up"
said 'Hisaab is UP' && said "https://hisaab.dhruvgoyal.tech" && said 'bash hisaab-down.sh' || fail "no closing box"
no_secrets_in_argv 'fully down'
grep -qF 'Authorization: Bearer fake-secret-value' "$FAKE_LOG.stdin" || fail "the Cloudflare token did not go on stdin"
called "--vault-name hisaab-ops-" && called "--vault-name hisaab-kv-" || fail "it did not read Hisaab's own vaults"
! called 'chitthi-kv-' && ! called 'chitthi-ops-' || fail "it read Chitthi's vaults"
echo "ok   fully down: IPv4 created and attached, VM started, alerts on, tagged up, box printed"

# -- Host already up, Chitthi on it ---------------------------------------------------------------
fake_up_host
run '{"app-hisaab":"down","app-chitthi":"up"}'
[[ $code -eq 0 ]] || fail "with Chitthi up: exit $code"
called '/start?' && fail "it started a VM that was running"
grep -qE -- '--method put .*(publicIPAddresses|/nic)' "$FAKE_LOG" && fail "it touched the network of a running host"
tagged_up || fail "Hisaab was not marked up"
grep -F 'tags/default' "$FAKE_LOG" | grep -qF 'app-chitthi' && fail "it wrote Chitthi's tag"
grep -F 'tags/default' "$FAKE_LOG" | grep -qF '"operation":"Merge"' || fail "the tag write can replace other tags"
called 'checks/h1/resume' || fail "Hisaab's backup check was not resumed"
called 'checks/c1' && fail "it touched Chitthi's healthchecks.io check"
dns_writes | grep -qF "\"name\":\"hisaab.dhruvgoyal.tech\",\"content\":\"$IP\"" || fail "the DNS write is not Hisaab's name at the host's address"
[[ $(dns_writes | wc -l) -eq 1 ]] || fail "more than one DNS write"
echo "ok   Chitthi up: VM and network untouched, only Hisaab's tag, monitors and record change"

# -- --app-only -----------------------------------------------------------------------------------
fake_up_host
run '{"app-hisaab":"down","app-chitthi":"up"}' --app-only
[[ $code -eq 0 ]] || fail "--app-only: exit $code"
called '/start?' && fail "--app-only started the VM"
called 'metricAlerts' && fail "--app-only touched the host's alerts"
tagged_up || fail "--app-only did not mark Hisaab up"
echo "ok   --app-only: Hisaab's steps alone"

fake_down_host
run '{"app-hisaab":"down"}' --app-only
[[ $code -ne 0 ]] && said 'has no address' || fail "--app-only on a host with no IPv4: exit $code"
tagged_up && fail "--app-only marked Hisaab up on a host that isn't"
echo "ok   --app-only with no host: stops, and stays marked down"

# -- The DNS step ---------------------------------------------------------------------------------
fake_up_host
run '{"app-hisaab":"down"}'
dns_writes | grep -qF 'PATCH' && dns_writes | grep -qF 'dns_records/r1' || fail "the parked record was not updated in place"
dns_writes | grep -qF '"ttl":60,"proxied":false' || fail "the record is not DNS only, TTL 60"
echo "ok   DNS: the parked record moves to the new address, DNS only, TTL 60"

FAKE_RECORDS='[]' run '{"app-hisaab":"down"}'
[[ $code -eq 0 ]] && dns_writes | grep -qF -- '-X POST' || fail "no record: it did not create one"
echo "ok   DNS: creates the record when there is none"

FAKE_RECORDS="[{\"id\":\"r1\",\"content\":\"$IP\",\"proxied\":false}]" run '{"app-hisaab":"up"}'
[[ $code -eq 0 && -z $(dns_writes) ]] || fail "a correct record was rewritten"
echo "ok   DNS: a re-run leaves a correct record alone"

FAKE_RECORDS="[{\"id\":\"r1\",\"content\":\"$IP\",\"proxied\":true}]" run '{"app-hisaab":"up"}'
dns_writes | grep -qF '"proxied":false' || fail "an orange-cloud record was left proxied"
echo "ok   DNS: turns off a proxied record at the right address"

FAKE_NO_ZONE=1 run '{"app-hisaab":"down"}'
[[ $code -ne 0 ]] && said "zone dhruvgoyal.tech isn't visible" || fail "a token that can't see the zone: exit $code"
echo "ok   DNS: a token that can't see the zone stops it"

FAKE_DNS_READONLY=1 run '{"app-hisaab":"down"}'
[[ $code -ne 0 ]] && said 'could not set hisaab.dhruvgoyal.tech' || fail "a token that can't edit: exit $code"
no_secrets_in_argv 'read-only token'
echo "ok   DNS: a token that can't edit stops it, without printing the token"

# -- Stops ----------------------------------------------------------------------------------------
# docs/MAINTENANCE.md, "First deploy": before the first deploy it stops here, with DNS already set.
fake_down_host
FAKE_HEALTH='' run '{"app-hisaab":"down"}'
[[ $code -ne 0 ]] && said 'The VM bills now' && said 'hisaab-down.sh --skip-backup' || fail "never healthy: exit $code"
called '/start?' && [[ -n $(dns_writes) ]] || fail "it should have started the VM and set DNS first"
called 'checks/h1/resume' && fail "it resumed the monitors on a site that never came up"
said 'Hisaab is UP' && fail "it printed the box for a site that isn't up"
echo "ok   never healthy: says the VM bills, monitors stay paused, no box"

fake_up_host
FAKE_BACKUP_RC=1 run '{"app-hisaab":"up"}'
[[ $code -ne 0 ]] && said 'FAIL From the VM' && said '1 dependency check(s) failed' || fail "a failed backup check: exit $code"
echo "ok   a failed dependency check: the box prints, the exit is non-zero"

FAKE_GOOGLE='302 https://accounts.google.com/signin/oauth/error?authError=x' run '{"app-hisaab":"up"}'
[[ $code -ne 0 ]] && said 'FAIL Google sign-in' || fail "a refused Google client: exit $code"
echo "ok   a refused Google client fails its check"

echo "up tests passed"
