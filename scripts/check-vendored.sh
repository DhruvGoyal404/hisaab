#!/usr/bin/env bash
# Fails if any vendored file differs from Chitthi at the pinned commit (deploy/VENDORED.md).
set -euo pipefail
COMMIT=55fbf40166438896581aa6b0782539eaf629678d
FILES=(deploy/edge/compose.yaml deploy/edge/Caddyfile deploy/host/edge.sh deploy/azure/lib.sh deploy/azure/host-up.sh deploy/azure/host-down.sh deploy/azure/audit.jq deploy/azure/run-on-vm.sh deploy/azure/age_keypair.py) # same path in both repos
cd "$(dirname "$0")/.."
grep -qF "$COMMIT" deploy/VENDORED.md || { echo "FAIL: deploy/VENDORED.md does not name $COMMIT"; exit 1; }
for f in "${FILES[@]}"; do
  upstream=$(curl -fsS --max-time 30 "https://raw.githubusercontent.com/DhruvGoyal404/chitthi/$COMMIT/$f")
  if [[ $upstream != "$(cat "$f")" ]]; then
    echo "FAIL: $f differs from chitthi@${COMMIT:0:7}"
    diff <(printf '%s\n' "$upstream") "$f" || true
    exit 1
  fi
  echo "ok   $f matches chitthi@${COMMIT:0:7}"
done
