#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Deliberately omits --volumes. Destructive cleanup remains an explicit,
# separately approved operation through network.sh clean/down.
docker compose -f "${MONGBAS_REPO_DIR}/network/docker-compose.yaml" stop
log "containers stopped; Docker volumes and runtime evidence were preserved"
