#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
require_cmd docker
require_cmd npm
require_cmd go

log "installing reproducible Node dependencies"
npm --prefix "${MONGBAS_REPO_DIR}/application" ci
npm --prefix "${MONGBAS_REPO_DIR}/frontend" ci
log "running chaincode unit/property tests"
(cd "${MONGBAS_REPO_DIR}/chaincode/voting" && go test ./...)
log "running standalone verifier tests"
npm --prefix "${MONGBAS_REPO_DIR}/verifier" ci
npm --prefix "${MONGBAS_REPO_DIR}/verifier" test
log "building frontend and fresh chaincode image"
npm --prefix "${MONGBAS_REPO_DIR}/frontend" run build
docker compose -f "${MONGBAS_REPO_DIR}/network/docker-compose.yaml" build --pull voting-chaincode
docker image inspect voting-chaincode:1.0 --format '{{json .RepoDigests}} {{.Id}}' > "${MONGBAS_RESULT_DIR}/chaincode-image-digest.txt"
log "build complete"
