#!/usr/bin/env bash
# Fails if any vendored file differs from Chitthi at the pinned commit (deploy/VENDORED.md).
set -euo pipefail
COMMIT=4b24b49eb2047f3a85e4b434718176ccdd5c08b9
FILES=(deploy/edge/compose.yaml deploy/edge/Caddyfile deploy/host/edge.sh) # same path in both repos
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
