#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd df
require_cmd docker
require_cmd git
require_cmd node
require_cmd python3
require_cmd setsid
require_cmd sha256sum
require_cmd timeout

[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for same-election paged evaluation"
ballots="${MONGBAS_SAME_ELECTION_BALLOTS:-100}"
rate="${MONGBAS_SAME_ELECTION_RATE:-5}"
max_in_flight="${MONGBAS_SAME_ELECTION_MAX_IN_FLIGHT:-20}"
[[ "${ballots}" =~ ^[0-9]+$ ]] && [ "${ballots}" -ge 100 ] && [ "${ballots}" -le 10000 ] || die "ballots must be 100..10000"
[[ "${rate}" =~ ^[0-9]+$ ]] && [ "${rate}" -ge 1 ] && [ "${rate}" -le 50 ] || die "rate must be 1..50"
[[ "${max_in_flight}" =~ ^[0-9]+$ ]] && [ "${max_in_flight}" -ge 1 ] && [ "${max_in_flight}" -le 100 ] || die "max in flight must be 1..100"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/same-election-paged-${ballots}-${run_id}"
install -d -m 0700 "${out}" "${out}/spool"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "same-election evaluation requires a clean worktree"

available_bytes="$(df -B1 --output=avail "${MONGBAS_RUNTIME_DIR}" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
estimated_growth_bytes=$((ballots * 600000))
required_bytes=$((estimated_growth_bytes * 2 + 20000000000))
printf 'ballots\testimatedGrowthBytes\trequiredAvailableBytes\tactualAvailableBytes\n%s\t%s\t%s\t%s\n' \
  "${ballots}" "${estimated_growth_bytes}" "${required_bytes}" "${available_bytes}" >"${out}/disk-preflight.tsv"
[ "${available_bytes}" -ge "${required_bytes}" ] || die "insufficient disk safety headroom"

docker exec cli peer lifecycle chaincode querycommitted --channelID voting-channel --name voting --output json \
  >"${out}/chaincode-before.json"
docker exec cli peer channel getinfo -c voting-channel >"${out}/channel-before.txt" 2>&1
docker stats --no-stream --format '{{json .}}' >"${out}/docker-stats-before.jsonl"

backend_pid=""
benchmark_pid=""
cleanup() {
  if [ -n "${benchmark_pid}" ] && kill -0 "${benchmark_pid}" 2>/dev/null; then
    kill -TERM -- "-${benchmark_pid}" 2>/dev/null || true
  fi
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill -TERM -- "-${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

benchmark_port="${MONGBAS_SAME_ELECTION_PORT:-3100}"
[[ "${benchmark_port}" =~ ^[0-9]+$ ]] && [ "${benchmark_port}" -ge 1024 ] && [ "${benchmark_port}" -le 65535 ] || die "invalid benchmark port"
if command -v ss >/dev/null && ss -H -ltn "sport = :${benchmark_port}" | grep -q .; then
  die "benchmark port is already in use: ${benchmark_port}"
fi

setsid env PORT="${benchmark_port}" LISTEN_HOST=127.0.0.1 NODE_ENV=development \
  FABRIC_ENDORSE_TIMEOUT_MS=600000 FABRIC_COMMIT_TIMEOUT_MS=600000 \
  DISABLE_RATE_LIMITS=true ENABLE_BENCHMARK_ENDPOINT=true CREDENTIAL_TTL_SEC=1800 \
  node "${MONGBAS_REPO_DIR}/application/src/app.js" >"${out}/backend.stdout.log" 2>"${out}/backend.stderr.log" &
backend_pid=$!
printf '%s\n' "${backend_pid}" >"${out}/backend.pid"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${benchmark_port}/health" >"${out}/backend-health.json"; then
    break
  fi
  kill -0 "${backend_pid}" 2>/dev/null || die "isolated benchmark backend terminated"
  sleep 1
done
python3 - "${out}/backend-health.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get("status")=="ok" and d.get("benchmark",{}).get("rateLimitsDisabled") is True
assert d.get("idemix",{}).get("enabled") is True and d.get("idemix",{}).get("asymEnabled") is True
PY

minimum_free_bytes=20000000000
maximum_seconds=$((ballots / rate * 4 + 1800))
printf 'timestampUtc\tavailableBytes\tminimumFreeBytes\tbackendAlive\n' >"${out}/monitor.tsv"
setsid timeout --signal=TERM --kill-after=30 "${maximum_seconds}" /usr/bin/time -v \
  node "${MONGBAS_REPO_DIR}/application/benchmark/same-election-paged-bench.js" \
    --url "http://127.0.0.1:${benchmark_port}" --ballots "${ballots}" --rate "${rate}" \
    --maxInFlight "${max_in_flight}" --out "${out}/evaluation.json" --spool "${out}/spool" \
    >"${out}/evaluation.stdout.log" 2>"${out}/evaluation.stderr.log" &
benchmark_pid=$!
printf '%s\n' "${benchmark_pid}" >"${out}/benchmark.pid"
abort=0
while kill -0 "${benchmark_pid}" 2>/dev/null; do
  current_available="$(df -B1 --output=avail "${MONGBAS_RUNTIME_DIR}" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
  backend_alive=false
  kill -0 "${backend_pid}" 2>/dev/null && backend_alive=true
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${current_available}" \
    "${minimum_free_bytes}" "${backend_alive}" >>"${out}/monitor.tsv"
  if [ "${current_available}" -lt "${minimum_free_bytes}" ] || [ "${backend_alive}" != true ]; then
    abort=1
    kill -TERM -- "-${benchmark_pid}" 2>/dev/null || true
    break
  fi
  sleep 10
done
set +e
wait "${benchmark_pid}"
status=$?
set -e
benchmark_pid=""
[ "${abort}" -eq 0 ] || status=75
printf '%s\n' "${status}" >"${out}/evaluation.exit-status.txt"

docker exec cli peer lifecycle chaincode querycommitted --channelID voting-channel --name voting --output json \
  >"${out}/chaincode-after.json"
docker exec cli peer channel getinfo -c voting-channel >"${out}/channel-after.txt" 2>&1
docker stats --no-stream --format '{{json .}}' >"${out}/docker-stats-after.jsonl"
cleanup
backend_pid=""

(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
  >"${out}/sha256-inventory.txt"
[ "${status}" -eq 0 ] || die "same-election paged evaluation failed; evidence saved to ${out}"
python3 - "${out}/evaluation.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get("evidenceValid") is True
assert d["cast"]["attempted"]==d["cast"]["committed"]==d["config"]["ballots"]
assert d["tally"]["success"] is True and d["pagedExport"]["ballots"]==d["config"]["ballots"]
PY
log "same-election paged evidence saved to ${out}"
