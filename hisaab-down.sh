#!/usr/bin/env bash
# Takes https://hisaab.dhruvgoyal.tech offline and stops everything that bills while idle.
# Pairs with hisaab-up.sh (docs/MAINTENANCE.md, "Up and down"). Git Bash, Cloud Shell or Linux:
#
#   bash hisaab-down.sh [--skip-backup] [--app-only]
#
# 1. A final backup on the VM (backup.sh run). If it fails, nothing is stopped, unless --skip-backup.
# 2. Monitors paused: healthchecks.io hisaab-* and the UptimeRobot monitor.
# 3. DNS parked: the A record points at 192.0.2.1 (routed nowhere), never at a released address.
# 4. The host: deploy/azure/host-down.sh (alerts off, deallocate, delete the IPv4, audit). Only if
#    no other app is up on the VM. Otherwise, or with --app-only, Hisaab is marked down and the VM
#    keeps running for that app: its own down script stops those costs.
# Re-runnable after a half-failed run. Exits non-zero if the audit finds anything still billing.
cd "$(dirname "$0")"
# shellcheck source=deploy/azure/lib.sh
source deploy/azure/lib.sh
# shellcheck source=deploy/azure/app.sh
source deploy/azure/app.sh

skip_backup='' app_only=''
for a in "$@"; do
  case $a in
    --skip-backup) skip_backup=1 ;;
    --app-only) app_only=1 ;;
    *) die "usage: bash hisaab-down.sh [--skip-backup] [--app-only]" ;;
  esac
done

preflight allow-disabled
use_app_vaults
vm=$(vm_json)
power=$(power_of <<<"$vm")

step "Final backup on the VM"
if [[ $power != PowerState/running ]]; then
  log "$VM is $power: nothing new since its last backup"
elif [[ -n $skip_backup ]]; then
  warn "--skip-backup: anything since last night's backup exists only on the VM's disk (which stays)"
else
  bash deploy/azure/run-on-vm.sh deploy/host/backup.sh run \
    || die "the final backup failed, so nothing was stopped. Fix it (docs/MAINTENANCE.md, \"A backup alert\"), or re-run with --skip-backup"
fi

step "Monitors: pause"
hc_set pause "$APP-" hisaab-hc-api-key
uptimerobot_set pause "$DOMAIN" hisaab-uptimerobot-api-key

step "DNS: park $DOMAIN"
cf_set_a "$ZONE" "$DOMAIN" "$PARKED_IP" hisaab-cloudflare-dns-token

others=$(apps_up "$vm" "$APP" | paste -sd, -)
if [[ -n $app_only || -n $others ]]; then
  set_app_state "$APP" down
  log ""
  log "$APP's own steps are done; the host is still up (${others:+for $others}${app_only:+--app-only})"
  [[ -z $others ]] || log "It keeps billing ₹0.48 an hour, and ₹1.03 more after the VM's free 12 months, until: bash $others-down.sh"
  exit 0
fi
bash deploy/azure/host-down.sh "app=$APP" # ends with the audit, non-zero if anything still bills

step "Is the site offline?"
if curl -sS --max-time 10 -o "$NULL_OUT" "https://$DOMAIN/api/health" 2>/dev/null; then
  warn "https://$DOMAIN still answered: a DNS cache somewhere has the old address (it can't last: that address is released)"
else
  log "https://$DOMAIN doesn't answer: offline"
fi
cat <<EOF

+----------------------------------------------------------------+
|  Hisaab is DOWN. Nothing bills beyond the audit above.        |
|  Bring it back:  bash hisaab-up.sh   (about 5-10 minutes)     |
+----------------------------------------------------------------+
EOF
