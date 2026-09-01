#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd docker
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for isolated fault evaluation"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/fault-${run_id}"
install -d -m 0700 "${out}"
cleanup() {
  # CouchDB 중단으로 종속 peer가 자발 종료될 수 있으므로 모든 허용 대상을 복구한다.
  docker start couchdb-ec1 >/dev/null 2>&1 || true
  docker start peer1.ec.voting.example.com >/dev/null 2>&1 || true
  docker start orderer4.orderer.voting.example.com >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_running() {
  local target="$1" deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    [ "$(docker inspect -f '{{.State.Status}}' "${target}" 2>/dev/null || true)" = running ] && return 0
    sleep 2
  done
  return 1
}

probe() {
  local label="$1"
  set +e
  node "${MONGBAS_REPO_DIR}/application/scripts/fault-probe.js" >"${out}/${label}.json" 2>"${out}/${label}.stderr.log"
  local status=$?
  set -e
  printf '%s\n' "${status}" >"${out}/${label}.exit-status.txt"
  return "${status}"
}

scenario() {
  local label="$1" target="$2"
  case "${target}" in
    peer1.ec.voting.example.com|couchdb-ec1|orderer4.orderer.voting.example.com) ;;
    *) die "target is not in non-destructive fault allowlist: ${target}" ;;
  esac
  log "scenario ${label}: stopping ${target}"
  docker inspect "${target}" >"${out}/${label}-before-inspect.json"
  docker stop -t 20 "${target}" >"${out}/${label}-stop.txt"
  docker ps --format '{{.Names}} {{.Status}}' >"${out}/${label}-during-docker-ps.txt"
  local attempt=1 converged=0 started_at="$(date +%s)"
  while [ "${attempt}" -le 5 ]; do
    if probe "${label}-during-attempt-${attempt}"; then converged=1; break; fi
    sleep 15
    attempt=$((attempt + 1))
  done
  printf 'attempts=%s\noutageSeconds=%s\n' "${attempt}" "$(( $(date +%s) - started_at ))" >"${out}/${label}-convergence.txt"
  [ "${converged}" -eq 1 ] || die "${label}: no exact probe succeeded during fault after ${attempt} attempts"
  docker start "${target}" >"${out}/${label}-start.txt"
  wait_running "${target}" || die "${label}: ${target} did not recover"
  if [ "${target}" = couchdb-ec1 ]; then
    docker start peer1.ec.voting.example.com >"${out}/${label}-dependent-peer-start.txt" 2>&1 || true
    wait_running peer1.ec.voting.example.com || die "${label}: dependent peer1 did not recover"
  fi
  sleep 5
  probe "${label}-recovery" || die "${label}: recovery probe failed"
  docker logs --since 10m "${target}" >"${out}/${label}-container.log" 2>&1 || true
}

"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "fault evaluation requires a clean worktree"

probe baseline || die "baseline exact probe failed"
scenario peer1-stop peer1.ec.voting.example.com
scenario peer1-couchdb-stop couchdb-ec1
scenario orderer4-stop orderer4.orderer.voting.example.com
probe final || die "final exact probe failed"

find "${out}" -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum >"${out}/sha256-inventory.txt"
log "fault evidence saved to ${out}"
