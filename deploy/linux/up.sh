#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
compose_file="${MONGBAS_REPO_DIR}/network/docker-compose.yaml"

if ! docker compose -f "${compose_file}" ps --status running --services | grep -qx 'peer0.ec.voting.example.com'; then
  log "Fabric is not initialized; creating channel and joining peers"
  "${MONGBAS_REPO_DIR}/network/scripts/network.sh" up
fi

log "deploying current chaincode definition"
"${MONGBAS_REPO_DIR}/network/scripts/network.sh" deploy
"${LINUX_DEPLOY_DIR}/healthcheck.sh"
log "Fabric is ready; start backend with systemd unit or: npm --prefix application start"
