#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd docker
require_cmd curl
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for isolated fault evaluation"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/critical-fault-${run_id}"
install -d -m 0700 "${out}"
cleanup() {
  docker start couchdb-ec0 >/dev/null 2>&1 || true
  docker start peer0.ec.voting.example.com >/dev/null 2>&1 || true
  docker start voting-chaincode >/dev/null 2>&1 || true
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

safe_inspect() {
  docker inspect --format '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Created":{{json .Created}},"State":{{json .State}},"RestartCount":{{json .RestartCount}},"Resources":{"Memory":{{json .HostConfig.Memory}},"NanoCpus":{{json .HostConfig.NanoCpus}},"CpusetCpus":{{json .HostConfig.CpusetCpus}}},"Networks":{{json .NetworkSettings.Networks}}}' "$1"
}

exact_probe() {
  local label="$1"
  set +e
  node "${MONGBAS_REPO_DIR}/application/scripts/fault-probe.js" >"${out}/${label}.json" 2>"${out}/${label}.stderr.log"
  local status=$?
  set -e
  printf '%s\n' "${status}" >"${out}/${label}.exit-status.txt"
  return "${status}"
}

require_available() {
  local label="$1" election_id="$2" http_status
  http_status="$(curl --silent --show-error --max-time 40 --output "${out}/${label}-body.txt" --write-out '%{http_code}' \
    "http://127.0.0.1:3000/api/elections/${election_id}" 2>"${out}/${label}-curl.stderr.log")"
  printf 'httpStatus=%s\n' "${http_status}" >"${out}/${label}-availability-result.txt"
  [[ "${http_status}" =~ ^2 ]] || die "${label}: healthy critical path did not return 2xx (HTTP ${http_status})"
}

expect_unavailable() {
  local label="$1" election_id="$2" started_at http_status curl_status
  started_at="$(date +%s)"
  set +e
  http_status="$(curl --silent --show-error --max-time 40 --output "${out}/${label}-body.txt" --write-out '%{http_code}' \
    "http://127.0.0.1:3000/api/elections/${election_id}" 2>"${out}/${label}-curl.stderr.log")"
  curl_status=$?
  set -e
  printf 'curlStatus=%s\nhttpStatus=%s\nelapsedSeconds=%s\n' "${curl_status}" "${http_status}" "$(( $(date +%s) - started_at ))" >"${out}/${label}-outage-result.txt"
  if [ "${curl_status}" -eq 0 ] && [[ "${http_status}" =~ ^2 ]]; then
    die "${label}: fault did not make the critical path unavailable"
  fi
}

observe_reads() {
  local label="$1" election_id="$2" attempt http_status curl_status
  for attempt in 1 2 3; do
    set +e
    http_status="$(curl --silent --show-error --max-time 40 --output "${out}/${label}-read-${attempt}-body.txt" --write-out '%{http_code}' \
      "http://127.0.0.1:3000/api/elections/${election_id}" 2>"${out}/${label}-read-${attempt}-curl.stderr.log")"
    curl_status=$?
    set -e
    printf 'curlStatus=%s\nhttpStatus=%s\n' "${curl_status}" "${http_status}" >"${out}/${label}-read-${attempt}-result.txt"
    [ "${attempt}" -eq 3 ] || sleep 5
  done
}

expect_write_unavailable() {
  local label="$1" election_id="critical-write-${run_id}" started_at http_status curl_status payload
  payload="{\"electionID\":\"${election_id}\",\"title\":\"Critical fault write probe\",\"candidates\":[\"A\",\"B\"],\"startTime\":$(date +%s),\"endTime\":$(( $(date +%s) + 1800 )),\"encryptionMode\":\"elgamal-vector-v3\"}"
  started_at="$(date +%s)"
  set +e
  http_status="$(printf 'Authorization: Bearer %s\n' "${ADMIN_API_TOKEN}" | \
    curl --header @- --silent --show-error --max-time 90 --request POST --header 'Content-Type: application/json' \
      --data-binary "${payload}" --output "${out}/${label}-write-body.txt" --write-out '%{http_code}' \
      'http://127.0.0.1:3000/api/elections' 2>"${out}/${label}-write-curl.stderr.log")"
  curl_status=$?
  set -e
  printf 'curlStatus=%s\nhttpStatus=%s\nelapsedSeconds=%s\n' "${curl_status}" "${http_status}" "$(( $(date +%s) - started_at ))" >"${out}/${label}-write-result.txt"
  if [ "${curl_status}" -eq 0 ] && [[ "${http_status}" =~ ^2 ]]; then
    die "${label}: state-changing request succeeded while primary CouchDB was stopped"
  fi
}

scenario() {
  local label="$1" target="$2" election_id="$3" check_mode="$4" dependent="${5:-}"
  case "${target}" in
    peer0.ec.voting.example.com|couchdb-ec0|voting-chaincode) ;;
    *) die "target is not in critical fault allowlist: ${target}" ;;
  esac
  require_available "${label}-before" "${election_id}"
  log "critical scenario ${label}: stopping ${target}"
  safe_inspect "${target}" >"${out}/${label}-before-inspect.json"
  docker stop -t 20 "${target}" >"${out}/${label}-stop.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' >"${out}/${label}-during-docker-ps.txt"
  case "${check_mode}" in
    unavailable) expect_unavailable "${label}-during" "${election_id}" ;;
    couchdb)
      observe_reads "${label}-during" "${election_id}"
      expect_write_unavailable "${label}-during"
      ;;
    *) die "unknown critical-path check mode: ${check_mode}" ;;
  esac
  docker start "${target}" >"${out}/${label}-start.txt"
  wait_running "${target}" || die "${label}: ${target} did not return to running"
  if [ -n "${dependent}" ]; then
    docker start "${dependent}" >"${out}/${label}-dependent-start.txt" 2>&1 || true
    wait_running "${dependent}" || die "${label}: ${dependent} did not return to running"
  fi
  sleep 8
  exact_probe "${label}-recovery" || die "${label}: exact recovery probe failed"
  docker logs --since 10m "${target}" >"${out}/${label}-container.log" 2>&1 || true
}

"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "critical fault evaluation requires a clean worktree"

exact_probe baseline || die "baseline exact probe failed"
probe_election_id="$(node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).electionID; if (!/^[A-Za-z0-9._-]+$/.test(value)) process.exit(1); process.stdout.write(value)" "${out}/baseline.json")"
[ -n "${probe_election_id}" ] || die "baseline did not produce an availability election ID"
scenario gateway-peer-stop peer0.ec.voting.example.com "${probe_election_id}" unavailable
scenario primary-couchdb-stop couchdb-ec0 "${probe_election_id}" couchdb peer0.ec.voting.example.com
scenario chaincode-service-stop voting-chaincode "${probe_election_id}" unavailable
exact_probe final || die "final exact probe failed"

find "${out}" -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum >"${out}/sha256-inventory.txt"
log "critical fault evidence saved to ${out}"
