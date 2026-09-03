#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
require_cmd docker
require_cmd npm
require_cmd go

log "installing reproducible Node dependencies"
npm --prefix "${MONGBAS_REPO_DIR}/application" ci --omit=dev --omit=optional
npm --prefix "${MONGBAS_REPO_DIR}/frontend" ci
npm --prefix "${MONGBAS_REPO_DIR}/frontend" test
log "running chaincode unit/property tests"
(cd "${MONGBAS_REPO_DIR}/chaincode/voting" && go test ./...)

log "running offline DKG/trustee custody tests"
npm --prefix "${MONGBAS_REPO_DIR}/trustee" ci
npm --prefix "${MONGBAS_REPO_DIR}/trustee" test
log "running standalone verifier tests"
npm --prefix "${MONGBAS_REPO_DIR}/verifier" ci
npm --prefix "${MONGBAS_REPO_DIR}/verifier" test
log "auditing deployed Node dependency sets"
npm --prefix "${MONGBAS_REPO_DIR}/application" audit --omit=dev --omit=optional --audit-level=high
npm --prefix "${MONGBAS_REPO_DIR}/frontend" audit --audit-level=high
npm --prefix "${MONGBAS_REPO_DIR}/verifier" audit --audit-level=high
log "building frontend and fresh chaincode image"
npm --prefix "${MONGBAS_REPO_DIR}/frontend" run build
docker compose -f "${MONGBAS_REPO_DIR}/network/docker-compose.yaml" build --pull voting-chaincode
docker image inspect voting-chaincode:1.0 --format '{{json .RepoDigests}} {{.Id}}' > "${MONGBAS_RESULT_DIR}/chaincode-image-digest.txt"
log "build complete"
