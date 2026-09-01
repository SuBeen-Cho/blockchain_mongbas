#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
out="${1:-${MONGBAS_RESULT_DIR}/environment-$(timestamp_utc)}"
install -d -m 0700 "${out}"
date --iso-8601=seconds > "${out}/date.txt"
uname -a > "${out}/uname.txt"
cp /etc/os-release "${out}/os-release.txt"
lscpu > "${out}/lscpu.txt"
free -h > "${out}/memory.txt"
df -hT > "${out}/disk.txt"
docker version > "${out}/docker-version.txt"
docker compose version > "${out}/compose-version.txt"
docker ps --no-trunc > "${out}/docker-ps.txt"
docker stats --no-stream > "${out}/docker-stats.txt"
node --version > "${out}/node-version.txt"
npm --version > "${out}/npm-version.txt"
go version > "${out}/go-version.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD > "${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" remote -v > "${out}/git-remotes.txt"
docker compose -f "${MONGBAS_REPO_DIR}/network/docker-compose.yaml" config > "${out}/compose-resolved.yaml"
docker image inspect voting-chaincode:1.0 --format '{{json .RepoDigests}} {{.Id}}' > "${out}/chaincode-image.txt"
ss -lntup > "${out}/ports.txt" 2>&1 || true
if command -v ufw >/dev/null 2>&1; then sudo ufw status verbose > "${out}/ufw.txt" 2>&1 || true; fi
chmod -R go-rwx "${out}"
log "environment evidence saved to ${out}"
