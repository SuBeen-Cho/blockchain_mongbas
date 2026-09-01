#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

docker compose -f "${MONGBAS_REPO_DIR}/network/docker-compose.yaml" ps
printf '\n%-28s %-12s %-12s\n' CONTAINER CPU MEMORY
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --max-time 5 "${MONGBAS_BASE_URL:-http://127.0.0.1:3000}/health"
  printf '\n'
fi
