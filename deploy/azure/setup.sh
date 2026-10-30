#!/usr/bin/env bash
# Azure setup for Hisaab's own half, on the host Chitthi's setup.sh built. The owner runs it in Azure
# Cloud Shell (Bash), signed in as themselves (they must be Owner of the subscription):
#
#   git clone https://github.com/DhruvGoyal404/hisaab && cd hisaab
#   bash deploy/azure/setup.sh app [region=malaysiawest] [subscription=<id>]
#   bash deploy/azure/setup.sh secrets      # generates or asks for each missing Key Vault secret
#   bash deploy/azure/setup.sh rotate name=<secret>   # a new value for one (docs/MAINTENANCE.md)
#   bash deploy/azure/setup.sh check        # read-only: verifies everything below
#   bash deploy/azure/setup.sh summary      # read-only: the checks (secrets as todo) and the GitHub values
#
# Adapted from Chitthi's deploy/azure/setup.sh. Re-runnable. Each step creates what's missing and
# brings settings back to what's written here. It never deletes anything, and never replaces a
# secret that exists. It changes nothing of Chitthi's and needs the VM only to read its identity.
#
# What it builds in resource group hisaab (docs/MAINTENANCE.md, "Azure setup"):
# - the backup storage account and container: the VM's identity may only create and read blobs
#   there; lifecycle rules expire dumps, manifests and selftest probes; 14 days of soft delete;
# - Key Vault: the VM's identity reads secrets, the owner manages them;
# - the ops vault: tokens only hisaab-up.sh and hisaab-down.sh use (Cloudflare DNS, the monitors'
#   APIs). The VM has no access to it: a compromised VM can't repoint DNS;
# - the deploy identity, which GitHub Actions signs in as (OIDC, environment "production"); it may
#   only use Run Command on the VM.
# The budget, alerts, network and the two custom roles are the host's: Chitthi's setup.sh owns them.
set -euo pipefail
umask 077

DEFAULT_REGION=malaysiawest # Azure for Students allows only a few regions (Chitthi's MAINTENANCE.md, "Region")
HOST_RG=apps-host
VM=apps-vm
APP_RG=hisaab
CONTAINER=backups
DEPLOY_ID=hisaab-deploy
GITHUB_REPO=DhruvGoyal404/hisaab
GITHUB_ENVIRONMENT=production # the deploy job's environment: you approve each deploy, from main only
BACKUP_ROLE="Blob create-only writer"
RUNCMD_ROLE="VM Run Command operator"
KEEP_DAYS=35
SOFT_DELETE_DAYS=14
SECRETS=(
  hisaab-postgres-password hisaab-api-db-password
  hisaab-google-client-id hisaab-google-client-secret hisaab-github-client-id hisaab-github-client-secret
  hisaab-backup-age-recipient hisaab-backup-age-identity
  hisaab-r2-endpoint hisaab-r2-access-key-id hisaab-r2-secret-access-key
  hisaab-hc-backup-url hisaab-hc-drill-url
)
OPS_SECRETS=(hisaab-cloudflare-dns-token hisaab-hc-api-key hisaab-uptimerobot-api-key) # in $OPS_KV

log() { echo "setup: $*"; }
die() { echo "setup: FAILED: $*" >&2; exit 1; }
q() { az "$@" --only-show-errors --output none; }      # run, no output
v() { az "$@" --only-show-errors --output tsv; }       # one value
# JSON from az, checked before jq reads it: a failure names the command and shows what came
# back, never a bare "jq: parse error". (Don't pass --output to v or q: their own wins, being last.)
json() {
  local out
  out=$(az "$@" --only-show-errors --output json) || return 1
  if ! jq -e . >/dev/null 2>&1 <<<"$out"; then
    echo "setup: 'az $1 $2 ${3:-}' did not return JSON: ${out:0:200}" >&2
    return 1
  fi
  printf '%s\n' "$out"
}
j() { json "$@" | jq -cS .; } # compact JSON, sorted keys
exists() { az "$@" --only-show-errors --output none >/dev/null 2>&1; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

declare -A arg=()
cmd=${1:-}
[[ $# -gt 0 ]] && shift
for kv in "$@"; do
  [[ $kv == *=* ]] || die "argument '$kv' is not key=value"
  arg[${kv%%=*}]=${kv#*=}
done
if ! command -v az >/dev/null || ! command -v jq >/dev/null; then die "run this in Azure Cloud Shell (Bash): it needs az and jq"; fi
LOCATION=${arg[region]:-$DEFAULT_REGION}
[[ $LOCATION =~ ^[a-z0-9]+$ ]] || die "region= must be an Azure region name, such as malaysiawest"
[[ -n ${arg[subscription]:-} ]] && q account set --subscription "${arg[subscription]}"
SUB=$(v account show --query id) || die "not signed in: run az login"
TENANT=$(v account show --query tenantId)
# Globally unique names, the same on every run for this subscription.
sfx=$(printf '%s' "$SUB" | sha256sum | cut -c1-6)
KV=hisaab-kv-$sfx
OPS_KV=hisaab-ops-$sfx
SA=hisaabbk$sfx
SUB_SCOPE=/subscriptions/$SUB
VM_ID=$SUB_SCOPE/resourceGroups/$HOST_RG/providers/Microsoft.Compute/virtualMachines/$VM
SA_ID=$SUB_SCOPE/resourceGroups/$APP_RG/providers/Microsoft.Storage/storageAccounts/$SA
CONTAINER_ID=$SA_ID/blobServices/default/containers/$CONTAINER
KV_ID=$SUB_SCOPE/resourceGroups/$APP_RG/providers/Microsoft.KeyVault/vaults/$KV
OPS_KV_ID=$SUB_SCOPE/resourceGroups/$APP_RG/providers/Microsoft.KeyVault/vaults/$OPS_KV

me() { v ad signed-in-user show --query id; }

# The subject GitHub puts in the deploy job's OIDC token. GitHub sends the immutable-ID form,
# repo:<owner>@<owner id>/<repo>@<repo id>:environment:<name>, not repo:<owner>/<repo>:...: the
# first deploy failed on exactly that (docs/MAINTENANCE.md, "Incidents"). Built from the GitHub
# API, never typed, and compared as an exact string by check().
github_subject() {
  local repo subject
  repo=$(curl -fsS --max-time 15 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GITHUB_REPO") \
    || die "could not read $GITHUB_REPO from the GitHub API (the OIDC subject needs its ids)"
  subject=$(jq -er --arg env "$GITHUB_ENVIRONMENT" '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id):environment:\($env)"' <<<"$repo") \
    || die "the GitHub API's answer for $GITHUB_REPO has no owner and repo ids"
  [[ $subject =~ ^repo:[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+:environment:[A-Za-z0-9_-]+$ ]] || die "unexpected OIDC subject '$subject'"
  printf '%s' "$subject"
}

lock() { # <resource group> <resource> <resource type> <notes>: a CanNotDelete lock, create or update
  if exists lock show --name do-not-delete -g "$1" --resource "$2" --resource-type "$3"; then
    q lock update --name do-not-delete -g "$1" --resource "$2" --resource-type "$3" --lock-type CanNotDelete --notes "$4"
  else
    q lock create --name do-not-delete -g "$1" --resource "$2" --resource-type "$3" --lock-type CanNotDelete --notes "$4"
  fi
}

# Role assignment, idempotent. New principals take a while to replicate, and new custom roles to
# become assignable, so it retries.
assign() { # <principal id> <principal type> <role> <scope>
  local n i
  n=$(v role assignment list --scope "$4" --query "length([?principalId=='$1' && roleDefinitionName=='$3'])")
  [[ $n == 0 ]] || return 0
  for i in $(seq 1 20); do
    if q role assignment create --assignee-object-id "$1" --assignee-principal-type "$2" --role "$3" --scope "$4" 2>/dev/null; then
      log "assigned '$3' on ${4##*/} to $2 $1"
      return 0
    fi
    [[ $i -eq 1 ]] && log "waiting for '$3' and the principal to replicate..."
    sleep 15
  done
  die "could not assign '$3' on $4 to $1"
}

# ==================================================================================================
app() {
  exists group show -n "$HOST_RG" || die "resource group $HOST_RG doesn't exist: this needs the host from Chitthi's setup.sh"
  exists vm show -g "$HOST_RG" -n "$VM" || die "there is no VM $VM in $HOST_RG"
  local role
  for role in "$BACKUP_ROLE" "$RUNCMD_ROLE"; do
    [[ $(v role definition list --custom-role-only true --name "$role" --query 'length(@)') == 1 ]] \
      || die "the custom role '$role' doesn't exist: it comes from Chitthi's setup.sh infra"
  done
  log "resource group $APP_RG"
  q group create -n "$APP_RG" -l "$LOCATION"
  storage
  key_vault
  identities "$(me)"
  check app
}

storage() {
  log "backup storage: $SA/$CONTAINER"
  if ! exists storage account show -g "$APP_RG" -n "$SA"; then
    q storage account create -g "$APP_RG" -n "$SA" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 --access-tier Hot \
      --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false --allow-shared-key-access false \
      --allow-cross-tenant-replication false
  else
    q storage account update -g "$APP_RG" -n "$SA" --access-tier Hot --min-tls-version TLS1_2 --https-only true \
      --allow-blob-public-access false --allow-shared-key-access false --allow-cross-tenant-replication false
  fi
  q storage account blob-service-properties update -g "$APP_RG" --account-name "$SA" \
    --enable-delete-retention true --delete-retention-days "$SOFT_DELETE_DAYS" \
    --enable-container-delete-retention true --container-delete-retention-days "$SOFT_DELETE_DAYS" \
    --enable-versioning false
  exists storage container-rm show -g "$APP_RG" --storage-account "$SA" -n "$CONTAINER" \
    || q storage container-rm create -g "$APP_RG" --storage-account "$SA" -n "$CONTAINER" --public-access off
  local policy
  policy=$(mktemp)
  jq -n --arg c "$CONTAINER" --argjson days "$KEEP_DAYS" '{rules: [{enabled: true, name: "expire-dumps-manifests-probes", type: "Lifecycle",
    definition: {actions: {baseBlob: {delete: {daysAfterCreationGreaterThan: $days}}},
                 filters: {blobTypes: ["blockBlob"], prefixMatch: ["\($c)/db/", "\($c)/manifests/", "\($c)/selftest/"]}}}]}' > "$policy"
  q storage account management-policy create -g "$APP_RG" --account-name "$SA" --policy @"$policy"
  rm -f "$policy"
  lock "$APP_RG" "$SA" Microsoft.Storage/storageAccounts "Off-VM backups"
}

key_vault() {
  log "Key Vault: $KV"
  exists keyvault show -g "$APP_RG" -n "$KV" \
    || q keyvault create -g "$APP_RG" -n "$KV" -l "$LOCATION" --sku standard \
         --enable-rbac-authorization true --enable-purge-protection true --retention-days 90
  lock "$APP_RG" "$KV" Microsoft.KeyVault/vaults "Secrets, including the backups' private key"
  log "ops vault: $OPS_KV (the owner only)"
  exists keyvault show -g "$APP_RG" -n "$OPS_KV"     || q keyvault create -g "$APP_RG" -n "$OPS_KV" -l "$LOCATION" --sku standard --enable-rbac-authorization true --retention-days 7
}

identities() { # <owner's object id>
  local vm_pid deploy_pid
  vm_pid=$(v vm show -g "$HOST_RG" -n "$VM" --query identity.principalId)
  [[ -n $vm_pid ]] || die "the VM has no system identity"
  assign "$vm_pid" ServicePrincipal "$BACKUP_ROLE" "$CONTAINER_ID"
  assign "$vm_pid" ServicePrincipal "Key Vault Secrets User" "$KV_ID"
  # The owner: manages secrets, and may clean up by hand (the VM can't).
  assign "$1" User "Key Vault Secrets Officer" "$KV_ID"
  assign "$1" User "Key Vault Secrets Officer" "$OPS_KV_ID"
  assign "$1" User "Storage Blob Data Contributor" "$CONTAINER_ID"

  exists identity show -g "$APP_RG" -n "$DEPLOY_ID" || q identity create -g "$APP_RG" -n "$DEPLOY_ID" -l "$LOCATION"
  local subject verb=create
  subject=$(github_subject)
  exists identity federated-credential show -g "$APP_RG" --identity-name "$DEPLOY_ID" -n "github-$GITHUB_ENVIRONMENT" && verb=update
  q identity federated-credential "$verb" -g "$APP_RG" --identity-name "$DEPLOY_ID" -n "github-$GITHUB_ENVIRONMENT" \
    --issuer https://token.actions.githubusercontent.com --subject "$subject" --audiences api://AzureADTokenExchange
  log "deploy identity trusts $subject"
  deploy_pid=$(v identity show -g "$APP_RG" -n "$DEPLOY_ID" --query principalId)
  assign "$deploy_pid" ServicePrincipal "$RUNCMD_ROLE" "$VM_ID"
}

ASKED=(
  'hisaab-google-client-id|Google OAuth client ID|^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$'
  'hisaab-google-client-secret|Google OAuth client secret|^[A-Za-z0-9_-]{20,}$'
  'hisaab-github-client-id|GitHub OAuth app client ID|^[A-Za-z0-9.]{16,}$'
  'hisaab-github-client-secret|GitHub OAuth app client secret|^[0-9a-f]{40}$'
  'hisaab-r2-endpoint|R2 S3 endpoint (https://<account id>.r2.cloudflarestorage.com)|^https://[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$'
  'hisaab-r2-access-key-id|R2 access key ID|^[0-9a-f]{32}$'
  'hisaab-r2-secret-access-key|R2 secret access key|^[0-9a-f]{64}$'
  'hisaab-hc-backup-url|healthchecks.io ping URL for the nightly backup|^https://hc-ping\.com/[A-Za-z0-9/_-]+$'
  'hisaab-hc-drill-url|healthchecks.io ping URL for the monthly restore drill|^https://hc-ping\.com/[A-Za-z0-9/_-]+$'
  'hisaab-cloudflare-dns-token|Cloudflare API token (Zone Read + DNS Edit, zone dhruvgoyal.tech only)|^[A-Za-z0-9_-]{40,}$'
  'hisaab-hc-api-key|healthchecks.io API key (read-write, the project with hisaab-backup)|^[A-Za-z0-9_-]{32,}$'
  'hisaab-uptimerobot-api-key|UptimeRobot Main API key|^[A-Za-z0-9_-]{20,}$'
)
open_vault() { # waits for access; sets $have (stored names) and $tmp
  local i ops_names
  exists keyvault show -g "$APP_RG" -n "$KV" || die "Key Vault $KV doesn't exist yet: run setup.sh app first"
  log "Key Vault $KV: waiting until you can manage secrets (a new role assignment takes a few minutes)"
  for i in $(seq 1 40); do
    have=$(v keyvault secret list --vault-name "$KV" --query '[].name' 2>/dev/null) && break
    [[ $i -lt 40 ]] || die "you still can't list secrets in $KV; run 'setup.sh app' first, or wait and retry"
    sleep 15
  done
  exists keyvault show -g "$APP_RG" -n "$OPS_KV" || die "the ops vault $OPS_KV doesn't exist yet: run setup.sh app first"
  ops_names=$(v keyvault secret list --vault-name "$OPS_KV" --query '[].name') || die "you can't list secrets in $OPS_KV yet; wait and retry"
  have+=$'\n'$ops_names
  tmp=$(mktemp -d -p /dev/shm 2>/dev/null || mktemp -d)
  # Expanded now: $tmp is the caller's local, gone by the time the trap runs.
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" EXIT
}
has() { grep -qx "$1" <<<"$have"; }
vault_of() { if [[ " ${OPS_SECRETS[*]} " == *" $1 "* ]]; then echo "$OPS_KV"; else echo "$KV"; fi; }
store() { # <name> <file>: a new value (a new version, if the name exists)
  q keyvault secret set --vault-name "$(vault_of "$1")" --name "$1" --file "$2" --encoding utf-8
  rm -f "$2"
  log "stored $1"
}
new_password() { # <name>: 32 characters of [A-Za-z0-9_-] (what deploy.sh requires)
  openssl rand -base64 24 | tr '+/' '-_' | tr -d '\n' > "$tmp/value"
  store "$1" "$tmp/value"
}
new_keypair() {
  rm -rf "$tmp/age" && mkdir "$tmp/age"
  python3 "$here/age_keypair.py" "$tmp/age"
  store hisaab-backup-age-identity "$tmp/age/identity"
  store hisaab-backup-age-recipient "$tmp/age/recipient"
  log "new backup keypair. Keep a copy of the private key outside Azure (a password manager): without it no backup can be read."
  log "  show it once with: az keyvault secret show --vault-name $KV -n hisaab-backup-age-identity --query value -o tsv"
}
ask() { # <name>: asks for the value (hidden), checks its shape, stores it
  local entry prompt shape value
  for entry in "${ASKED[@]}"; do
    [[ ${entry%%|*} == "$1" ]] || continue
    prompt=${entry#*|}; shape=${prompt#*|}; prompt=${prompt%%|*}
    while :; do
      read -rsp "  $prompt: " value
      echo
      [[ $value =~ $shape ]] && break
      echo "  that doesn't look like one; try again (Ctrl-C to stop; what's stored so far stays)"
    done
    printf '%s' "$value" > "$tmp/value"
    unset value
    store "$1" "$tmp/value"
    return 0
  done
  die "no such secret: $1"
}

secrets() { # every missing secret: generated or asked for; never replaces one
  local have tmp name entry
  open_vault
  for name in hisaab-postgres-password hisaab-api-db-password; do
    has "$name" || new_password "$name"
  done
  if has hisaab-backup-age-identity && has hisaab-backup-age-recipient; then
    :
  elif has hisaab-backup-age-identity || has hisaab-backup-age-recipient; then
    die "only one half of the backup keypair is in Key Vault; restore the other half (or, if no backup was ever made, delete both and re-run)"
  else
    new_keypair
  fi
  for entry in "${ASKED[@]}"; do
    has "${entry%%|*}" || ask "${entry%%|*}"
  done
  log "all secrets are in $KV"
}

rotate() { # <name>: a new value for one secret (docs/MAINTENANCE.md, "Secret rotation")
  local have tmp name=${arg[name]:-}
  [[ -n $name ]] || die "usage: setup.sh rotate name=<secret>"
  open_vault
  has "$name" || die "$name isn't stored yet: use setup.sh secrets"
  case $name in
    hisaab-postgres-password | hisaab-api-db-password)
      new_password "$name"
      log "next: deploy (Actions > Deploy > Run workflow). The deploy sets the new password in Postgres." ;;
    hisaab-backup-age-identity | hisaab-backup-age-recipient)
      # Old dumps stay encrypted to the old key until they expire: the old private key is kept as -previous, which the drill and restore also use.
      if has hisaab-backup-age-identity-previous; then
        die "hisaab-backup-age-identity-previous still exists. Delete it only once nothing encrypted to it remains (35 days after the last rotation, docs/MAINTENANCE.md), then rotate again"
      fi
      az keyvault secret show --vault-name "$KV" --name hisaab-backup-age-identity --query value --output tsv --only-show-errors \
        | tr -d '\n' > "$tmp/previous"
      [[ -s $tmp/previous ]] || die "could not read the current private key"
      store hisaab-backup-age-identity-previous "$tmp/previous"
      new_keypair
      log "next: tonight's backup uses the new key; keep the old private key (now -previous) until $(date -u -d '+35 days' +%F)." ;;
    *)
      ask "$name"
      log "next: deploy for OAuth secrets; the backup secrets are read at every run. Then revoke the old value at its provider." ;;
  esac
}

# ==================================================================================================
check() { # [app|summary]: secrets not yet stored are reported as todo, not counted
  local fails=0 todo=0 got vm_pid deploy_pid name names
  ok() { echo "ok   $*"; }
  bad() { echo "FAIL $*"; fails=$((fails + 1)); }
  expect() { if [[ $2 == "$3" ]]; then ok "$1"; else bad "$1: got $2, expected $3"; fi; }
  lower() { tr '[:upper:]' '[:lower:]'; }

  for name in "storage account:$APP_RG:$SA:Microsoft.Storage/storageAccounts" "Key Vault:$APP_RG:$KV:Microsoft.KeyVault/vaults"; do
    IFS=: read -r what rg res type <<<"$name"
    expect "$what $res can't be deleted (lock)" "$(v lock list -g "$rg" --resource "$res" --resource-type "$type" --query "[?level=='CanNotDelete'] | length(@)")" 1
  done

  # Backup storage
  got=$(j storage account show -g "$APP_RG" -n "$SA" --query "{sharedKey: allowSharedKeyAccess, publicBlobs: allowBlobPublicAccess, tls: minimumTlsVersion, httpsOnly: enableHttpsTrafficOnly, tier: accessTier}")
  expect "storage account: Entra sign-in only, no public blobs, TLS 1.2, HTTPS, Hot tier" "$got" '{"httpsOnly":true,"publicBlobs":false,"sharedKey":false,"tier":"Hot","tls":"TLS1_2"}'
  got=$(j storage account blob-service-properties show -g "$APP_RG" --account-name "$SA" \
    --query "{softDelete: deleteRetentionPolicy.enabled, days: deleteRetentionPolicy.days, versioning: isVersioningEnabled || \`false\`}")
  expect "blob soft delete for $SOFT_DELETE_DAYS days, no versioning" "$got" "{\"days\":$SOFT_DELETE_DAYS,\"softDelete\":true,\"versioning\":false}"
  got=$(j storage account management-policy show -g "$APP_RG" --account-name "$SA" \
    --query "policy.rules[?enabled].{days: definition.actions.baseBlob.delete.daysAfterCreationGreaterThan, prefixes: definition.filters.prefixMatch}" \
    | jq -c 'map(.days |= floor)') # Azure returns the days as a float
  expect "lifecycle deletes db/, manifests/ and selftest/ after $KEEP_DAYS days, and nothing else" "$got" \
    "[{\"days\":$KEEP_DAYS,\"prefixes\":[\"$CONTAINER/db/\",\"$CONTAINER/manifests/\",\"$CONTAINER/selftest/\"]}]"
  expect "container $CONTAINER is private" "$(v storage container-rm show -g "$APP_RG" --storage-account "$SA" -n "$CONTAINER" --query publicAccess)" None

  # Roles: exactly what each identity needs, nothing more
  got=$(j role definition list --custom-role-only true --name "$BACKUP_ROLE" --query "[0].permissions[0].{actions: actions, data: sort(dataActions)}")
  expect "role '$BACKUP_ROLE' grants create and read only" "$got" \
    '{"actions":[],"data":["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action","Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"]}'
  got=$(j role definition list --custom-role-only true --name "$RUNCMD_ROLE" --query "[0].permissions[0].{actions: sort(actions), data: dataActions}")
  expect "role '$RUNCMD_ROLE' grants Run Command only" "$got" \
    '{"actions":["Microsoft.Compute/virtualMachines/read","Microsoft.Compute/virtualMachines/runCommands/delete","Microsoft.Compute/virtualMachines/runCommands/read","Microsoft.Compute/virtualMachines/runCommands/write"],"data":[]}'
  vm_pid=$(v vm show -g "$HOST_RG" -n "$VM" --query identity.principalId)
  # Only this app's resource group: the VM also holds the roles of the other apps on it.
  got=$(json role assignment list --all --query "sort([?principalId=='$vm_pid' && contains(scope, '/resourceGroups/$APP_RG/')].join('@', [roleDefinitionName, scope]))" | jq -r 'join(" ")' | lower)
  expect "in $APP_RG the VM's identity holds exactly: create-only on $CONTAINER, Secrets User on $KV" "$got" \
    "$(echo "$BACKUP_ROLE@$CONTAINER_ID Key Vault Secrets User@$KV_ID" | lower)"
  deploy_pid=$(v identity show -g "$APP_RG" -n "$DEPLOY_ID" --query principalId)
  got=$(json role assignment list --all --query "[?principalId=='$deploy_pid'].join('@', [roleDefinitionName, scope])" | jq -r 'join(" ")' | lower)
  expect "the deploy identity holds exactly: Run Command on $VM" "$got" "$(echo "$RUNCMD_ROLE@$VM_ID" | lower)"
  got=$(j identity federated-credential list -g "$APP_RG" --identity-name "$DEPLOY_ID" --query "[].{issuer: issuer, subject: subject, audiences: audiences}")
  # The exact subject GitHub sends, from its API: a hand-built repo:<owner>/<repo> form passed
  # this check once while Azure refused every sign-in.
  local want_subject
  want_subject=$(github_subject)
  expect "the deploy identity trusts exactly $want_subject" "$got" \
    "$(jq -cn --arg s "$want_subject" '[{audiences: ["api://AzureADTokenExchange"], issuer: "https://token.actions.githubusercontent.com", subject: $s}]')"

  # Key Vault and its secrets (names only)
  got=$(j keyvault show -g "$APP_RG" -n "$KV" --query "{rbac: properties.enableRbacAuthorization, purgeProtection: properties.enablePurgeProtection, softDelete: properties.enableSoftDelete}")
  expect "Key Vault: RBAC, soft delete, purge protection" "$got" '{"purgeProtection":true,"rbac":true,"softDelete":true}'
  expect "ops vault $OPS_KV: RBAC (the VM holds no role on it: see its roles above)" "$(j keyvault show -g "$APP_RG" -n "$OPS_KV" --query properties.enableRbacAuthorization 2>/dev/null || echo missing)" true
  names=$(v keyvault secret list --vault-name "$OPS_KV" --query '[].name' 2>/dev/null || true)
  for name in "${OPS_SECRETS[@]}"; do
    grep -qx "$name" <<<"$names" || echo "todo $name in $OPS_KV (setup.sh secrets): hisaab-up.sh and hisaab-down.sh need it"
  done
  if names=$(v keyvault secret list --vault-name "$KV" --query '[].name' 2>/dev/null); then
    for name in "${SECRETS[@]}"; do
      if grep -qx "$name" <<<"$names"; then :
      elif [[ ${1:-} == app || ${1:-} == summary ]]; then todo=$((todo + 1))
      else bad "secret $name is missing (setup.sh secrets)"
      fi
    done
    if [[ $todo -gt 0 ]]; then echo "todo $todo secrets to store: bash deploy/azure/setup.sh secrets"; else ok "all ${#SECRETS[@]} secrets are stored"; fi
  else
    if [[ ${1:-} == app || ${1:-} == summary ]]; then echo "todo secrets: your Key Vault access is still replicating; run setup.sh secrets in a few minutes"
    else bad "can't list secrets in $KV"; fi
  fi

  echo
  if [[ $fails -gt 0 ]]; then die "$fails check(s) failed"; fi
  log "all checks passed"
}

# Read-only: every check (missing secrets shown as todo), then the IP and the GitHub values, even
# when some checks fail. Exits non-zero if any did.
summary() {
  local rc=0
  ( check summary ) || rc=$?
  next_steps
  return "$rc"
}

next_steps() {
  local client_id
  client_id=$(v identity show -g "$APP_RG" -n "$DEPLOY_ID" --query clientId 2>/dev/null || echo "(no deploy identity yet)")
  cat <<EOF

Next (docs/MAINTENANCE.md, "Going live"):
  1. Secrets: bash deploy/azure/setup.sh secrets
  2. GitHub, environment "$GITHUB_ENVIRONMENT" (Settings > Environments > $GITHUB_ENVIRONMENT):
     secrets (masked in the public logs):
       AZURE_CLIENT_ID=$client_id
       AZURE_TENANT_ID=$TENANT
       AZURE_SUBSCRIPTION_ID=$SUB
       KEY_VAULT=$KV  BACKUP_ACCOUNT=$SA  R2_BUCKET=hisaab-backups
     variables:
       VM_RG=$HOST_RG  VM_NAME=$VM  BACKUP_CONTAINER=$CONTAINER
     then the repository variable DEPLOY_ENABLED=true
  3. The first deploy: bash hisaab-up.sh brings the VM up (it stops at health: nothing is deployed
     yet), then Actions > Deploy > Run workflow, then bash hisaab-up.sh again
  4. After the first deploy: bash deploy/azure/run-on-vm.sh deploy/host/backup.sh selftest
EOF
}

case $cmd in
  app) app ;;
  secrets) secrets ;;
  rotate) rotate ;;
  check) check ;;
  summary) summary ;;
  *) die "usage: setup.sh app [region=] [subscription=<id>] | secrets | rotate name=<secret> | check | summary" ;;
esac
