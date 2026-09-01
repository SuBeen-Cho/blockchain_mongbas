#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

timeout_seconds="${MONGBAS_HEALTH_TIMEOUT:-180}"
deadline=$((SECONDS + timeout_seconds))
required=(orderer1.orderer.voting.example.com peer0.ec.voting.example.com peer0.party.voting.example.com peer0.civil.voting.example.com voting-chaincode)
while (( SECONDS < deadline )); do
  failed=0
  for name in "${required[@]}"; do
    state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || true)"
    [ "$state" = running ] || failed=1
  done
  [ "$failed" -eq 0 ] && { log "required Fabric containers are running"; exit 0; }
  sleep 2
done
die "Fabric readiness timed out after ${timeout_seconds}s"
