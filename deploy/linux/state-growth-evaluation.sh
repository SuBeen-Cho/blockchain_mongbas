#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd docker
require_cmd df
require_cmd git
require_cmd node
require_cmd sha256sum
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for state-growth evaluation"

ballots="${MONGBAS_STATE_GROWTH_BALLOTS:-1000}"
[[ "${ballots}" =~ ^[0-9]+$ ]] && [ "${ballots}" -ge 100 ] && [ "${ballots}" -le 100000 ] || die "ballots must be 100..100000"
rate="${MONGBAS_STATE_GROWTH_RATE:-}"
if [ -z "${rate}" ]; then
  if [ "${ballots}" -gt 90000 ]; then rate=50; else rate=25; fi
fi
[[ "${rate}" =~ ^[0-9]+$ ]] && [ "${rate}" -ge 1 ] && [ "${rate}" -le 200 ] || die "rate must be 1..200"
[ $((ballots % rate)) -eq 0 ] || die "ballots must be exactly divisible by rate"
duration=$((ballots / rate))
[ "${duration}" -ge 5 ] && [ "${duration}" -le 3600 ] || die "derived duration must be 5..3600 seconds"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/state-growth-${ballots}-${run_id}"
install -d -m 0700 "${out}/workload-results"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "state-growth evaluation requires a clean worktree"

# The default is deliberately above the observed 10k replicated-topology
# growth (558,722.662 bytes/ballot). It is a launch safety gate, not a
# capacity prediction; the report must retain the actual before/after data.
estimated_bytes_per_ballot="${MONGBAS_STATE_GROWTH_ESTIMATED_BYTES_PER_BALLOT:-600000}"
disk_safety_factor="${MONGBAS_STATE_GROWTH_DISK_SAFETY_FACTOR:-2}"
[[ "${estimated_bytes_per_ballot}" =~ ^[0-9]+$ ]] && [ "${estimated_bytes_per_ballot}" -ge 100000 ] && \
  [ "${estimated_bytes_per_ballot}" -le 5000000 ] || die "estimated bytes per ballot must be 100000..5000000"
[[ "${disk_safety_factor}" =~ ^[0-9]+$ ]] && [ "${disk_safety_factor}" -ge 1 ] && \
  [ "${disk_safety_factor}" -le 5 ] || die "disk safety factor must be 1..5"
available_bytes="$(df -B1 --output=avail "${MONGBAS_RUNTIME_DIR}" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
[[ "${available_bytes}" =~ ^[0-9]+$ ]] || die "could not measure available runtime filesystem bytes"
estimated_growth_bytes=$((ballots * estimated_bytes_per_ballot))
required_available_bytes=$((estimated_growth_bytes * disk_safety_factor))
printf 'ballots\testimatedBytesPerBallot\testimatedGrowthBytes\tsafetyFactor\trequiredAvailableBytes\tactualAvailableBytes\n' \
  >"${out}/disk-preflight.tsv"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${ballots}" "${estimated_bytes_per_ballot}" "${estimated_growth_bytes}" \
  "${disk_safety_factor}" "${required_available_bytes}" "${available_bytes}" >>"${out}/disk-preflight.tsv"
[ "${available_bytes}" -ge "${required_available_bytes}" ] || \
  die "insufficient disk headroom: require ${required_available_bytes} bytes, have ${available_bytes}; evidence retained in ${out}"

targets=(
  'peer0.civil.voting.example.com|ledger|/var/hyperledger/production'
  'peer0.ec.voting.example.com|ledger|/var/hyperledger/production'
  'peer1.ec.voting.example.com|ledger|/var/hyperledger/production'
  'peer0.party.voting.example.com|ledger|/var/hyperledger/production'
  'orderer1.orderer.voting.example.com|orderer|/var/hyperledger/production'
  'orderer2.orderer.voting.example.com|orderer|/var/hyperledger/production'
  'orderer3.orderer.voting.example.com|orderer|/var/hyperledger/production'
  'orderer4.orderer.voting.example.com|orderer|/var/hyperledger/production'
  'couchdb-civil|couchdb|/opt/couchdb/data'
  'couchdb-ec0|couchdb|/opt/couchdb/data'
  'couchdb-ec1|couchdb|/opt/couchdb/data'
  'couchdb-party|couchdb|/opt/couchdb/data'
)

snapshot() {
  local destination="$1" item name kind data_path kib
  : >"${destination}"
  for item in "${targets[@]}"; do
    IFS='|' read -r name kind data_path <<<"${item}"
    [ "$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null)" = running ] || die "snapshot target is not running: ${name}"
    kib="$(docker exec "${name}" du -sk "${data_path}" | awk '{print $1}')"
    [[ "${kib}" =~ ^[0-9]+$ ]] || die "invalid storage measurement for ${name}"
    printf '%s\t%s\t%s\n' "${name}" "${kind}" "${kib}" >>"${destination}"
  done
}

snapshot "${out}/storage-before.tsv"
docker ps --no-trunc --size >"${out}/containers-before.txt"
set +e
MONGBAS_RATE_RESULT_ROOT="${out}/workload-results" MONGBAS_RATE_LEVELS="${rate}" \
  MONGBAS_RATE_DURATION_SECONDS="${duration}" MONGBAS_RATE_REPEATS=1 \
  "${LINUX_DEPLOY_DIR}/rate-evaluation.sh" >"${out}/workload.stdout.log" 2>"${out}/workload.stderr.log"
workload_status=$?
set -e
printf '%s\n' "${workload_status}" >"${out}/workload.exit-status.txt"
snapshot "${out}/storage-after.tsv"
docker ps --no-trunc --size >"${out}/containers-after.txt"

node "${MONGBAS_REPO_DIR}/application/benchmark/summarize-state-growth.js" \
  "${out}/storage-before.tsv" "${out}/storage-after.tsv" "${ballots}" "${out}/state-growth-summary.json"
printf '{"schema":"mongbas-state-growth-evaluation/v1","ballots":%s,"offeredRate":%s,"durationSeconds":%s,"workloadExitStatus":%s,"gitCommit":"%s"}\n' \
  "${ballots}" "${rate}" "${duration}" "${workload_status}" "$(cat "${out}/git-commit.txt")" >"${out}/metadata.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "state-growth evidence saved to ${out}"
[ "${workload_status}" -eq 0 ] || die "state-growth workload failed; evidence retained"
