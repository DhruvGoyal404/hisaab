# shellcheck shell=bash
# Hisaab's names on top of the vendored deploy/azure/lib.sh, which is Chitthi's. Sourced after it.
# shellcheck disable=SC2034 # the constants are for the scripts that source this
APP=hisaab
DOMAIN=hisaab.dhruvgoyal.tech
ZONE=dhruvgoyal.tech

# Call after preflight: Hisaab has its own vaults, named the way setup.sh names them.
use_app_vaults() {
  local sfx
  sfx=$(printf '%s' "$SUB" | sha256sum | cut -c1-6)
  KV=hisaab-kv-$sfx
  OPS_KV=hisaab-ops-$sfx
}
