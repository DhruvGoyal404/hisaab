#!/usr/bin/env bash
# Runs hisaab-down.sh against stand-ins for az and curl, on the decision that matters on a shared
# VM: it must take the host down only when no other app is up, and leave it alone otherwise.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
bin=$(mktemp -d)
trap 'rm -rf -- "$bin"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

cat > "$bin/az" <<'EOF'
#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
case "$1 $2" in
  'account show') [[ $* == *--query* ]] && echo 'Fake sub'; exit 0 ;;
  'account list') echo 00000000-0000-0000-0000-00000000c0de; exit 0 ;;
  'account set') exit 0 ;;
  'group exists') echo true; exit 0 ;;
  'keyvault secret') echo fake-secret; exit 0 ;;
esac
url=''
for ((i = 1; i <= $#; i++)); do [[ ${!i} == --url ]] && { j=$((i + 1)); url=${!j}; }; done
case $url in
  */subscriptions/*\?api-version=2022-12-01) echo '{"state":"Enabled"}' ;;
  */virtualMachines/apps-vm\?*)
    grep -qF '/deallocate' "$FAKE_LOG" && FAKE_POWER=deallocated
    printf '{"location":"malaysiawest","tags":%s,"properties":{"instanceView":{"statuses":[{"code":"PowerState/%s"}]},"networkProfile":{"networkInterfaces":[{"id":"/nic"}]}}}\n' "$FAKE_TAGS" "$FAKE_POWER" ;;
  */nic\?*) echo '{"location":"malaysiawest","properties":{"ipConfigurations":[{"properties":{}}]}}' ;;
  */publicIPAddresses/*) echo 'ERROR: (NotFound) gone' >&2; exit 1 ;;
  */metricAlerts/*|*/activityLogAlerts/*) echo 'ERROR: (NotFound) gone' >&2; exit 1 ;;
  */CostManagement/*) echo '{"properties":{"rows":[]}}' ;;
  */resources\?*|*/disks\?*) echo '{"value":[]}' ;;
  *) echo '{}' ;;
esac
EOF
cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *healthchecks.io/api/v3/checks/*) echo '{"checks":[]}' ;;
  *uptimerobot*) echo '{"stat":"ok","monitors":[]}' ;;
  *'/zones?name='*) echo '{"result":[{"id":"z"}]}' ;;
  *dns_records*) echo '{"result":[{"id":"r","content":"192.0.2.1","proxied":false}]}' ;;
  *) exit 7 ;; # the site: offline
esac
EOF
chmod +x "$bin/az" "$bin/curl"

run() { # <tags JSON> [args...]: sets $out, $code and the az call log
  FAKE_LOG=$bin/log FAKE_TAGS=$1 FAKE_POWER=${FAKE_POWER:-running}
  export FAKE_LOG FAKE_TAGS FAKE_POWER
  shift
  : > "$FAKE_LOG"
  set +e
  out=$(PATH=$bin:$PATH ARM_RETRY_SECONDS=0 bash "$repo/hisaab-down.sh" --skip-backup "$@" 2>&1)
  code=$?
  set -e
}
tagged_down() { grep -F 'tags/default' "$FAKE_LOG" | grep -qF "\"app-$1\":\"down\""; }
deallocated() { grep -qF '/deallocate' "$FAKE_LOG"; }

run '{"app-hisaab":"up","app-chitthi":"up"}'
[[ $code -eq 0 ]] || { echo "$out"; fail "with Chitthi up, the script exited $code"; }
deallocated && fail "it deallocated the VM while Chitthi is up"
tagged_down hisaab || fail "Hisaab was not marked down"
grep -qF 'until: bash chitthi-down.sh' <<<"$out" || fail "it did not say the VM keeps billing"
echo "ok   Chitthi up: the VM stays, Hisaab is marked down"

run '{"app-hisaab":"up","app-chitthi":"hosted"}'
deallocated && fail "it read the older 'hosted' as down"
echo "ok   Chitthi tagged 'hosted': read as up"

run '{"app-hisaab":"up","app-chitthi":"down"}'
[[ $code -eq 0 ]] || { echo "$out"; fail "the full down exited $code"; }
deallocated || fail "it left the VM running with no app up"
tagged_down hisaab || fail "Hisaab was not marked down"
grep -qF 'audit clean' <<<"$out" || fail "the audit did not run"
echo "ok   Chitthi down: the VM is deallocated and the audit is clean"

run '{"app-hisaab":"up"}' --app-only
deallocated && fail "--app-only took the host down"
tagged_down hisaab || fail "--app-only did not mark Hisaab down"
echo "ok   --app-only: Hisaab's steps alone"

echo "down tests passed"
