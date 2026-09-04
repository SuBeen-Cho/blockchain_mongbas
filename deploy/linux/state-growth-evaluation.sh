#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd docker
require_cmd df
require_cmd git
require_cmd curl
require_cmd node
require_cmd sha256sum
require_cmd setsid
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

disk_sample_seconds="${MONGBAS_STATE_GROWTH_DISK_SAMPLE_SECONDS:-30}"
minimum_free_bytes="${MONGBAS_STATE_GROWTH_MIN_FREE_BYTES:-${estimated_growth_bytes}}"
minimum_mem_available_bytes="${MONGBAS_STATE_GROWTH_MIN_MEM_AVAILABLE_BYTES:-536870912}"
[[ "${disk_sample_seconds}" =~ ^[0-9]+$ ]] && [ "${disk_sample_seconds}" -ge 5 ] && \
  [ "${disk_sample_seconds}" -le 300 ] || die "disk sample seconds must be 5..300"
[[ "${minimum_free_bytes}" =~ ^[0-9]+$ ]] && [ "${minimum_free_bytes}" -ge 5000000000 ] && \
  [ "${minimum_free_bytes}" -le "${available_bytes}" ] || die "minimum free bytes must be at least 5000000000 and no greater than current availability"
[[ "${minimum_mem_available_bytes}" =~ ^[0-9]+$ ]] && [ "${minimum_mem_available_bytes}" -ge 268435456 ] && \
  [ "${minimum_mem_available_bytes}" -le 4294967296 ] || die "minimum available memory must be 256MiB..4GiB"
printf 'timestampUtc\tavailableBytes\tminimumFreeBytes\tevent\n' >"${out}/disk-monitor.tsv"
printf 'timestampUtc\tmemAvailableBytes\tswapFreeBytes\toomKillCount\thealth\tevent\n' >"${out}/resource-monitor.tsv"

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
    [ "$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null)" = running ] || {
      printf 'snapshot target is not running: %s\n' "${name}" >&2
      return 1
    }
    kib="$(docker exec "${name}" du -sk "${data_path}" | awk '{print $1}')"
    [[ "${kib}" =~ ^[0-9]+$ ]] || {
      printf 'invalid storage measurement for %s\n' "${name}" >&2
      return 1
    }
    printf '%s\t%s\t%s\n' "${name}" "${kind}" "${kib}" >>"${destination}"
  done
}

snapshot "${out}/storage-before.tsv" || die "pre-run storage snapshot failed"
docker ps --no-trunc --size >"${out}/containers-before.txt"
workload_pid=""
stop_workload() {
  if [ -n "${workload_pid}" ] && kill -0 "${workload_pid}" 2>/dev/null; then
    kill -TERM -- "-${workload_pid}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${workload_pid}" 2>/dev/null || return 0
      sleep 1
    done
    kill -KILL -- "-${workload_pid}" 2>/dev/null || true
  fi
}
trap 'stop_workload' EXIT INT TERM

setsid env MONGBAS_RATE_RESULT_ROOT="${out}/workload-results" MONGBAS_RATE_LEVELS="${rate}" \
  MONGBAS_RATE_DURATION_SECONDS="${duration}" MONGBAS_RATE_REPEATS=1 \
  "${LINUX_DEPLOY_DIR}/rate-evaluation.sh" >"${out}/workload.stdout.log" 2>"${out}/workload.stderr.log" &
workload_pid=$!
disk_abort=0
abort_reason=""
health_seen=0
health_grace_deadline=$((SECONDS + 120))
baseline_oom_kills="$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)"
[[ "${baseline_oom_kills}" =~ ^[0-9]+$ ]] || die "could not read the kernel oom_kill counter"
while kill -0 "${workload_pid}" 2>/dev/null; do
  observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  current_available_bytes="$(df -B1 --output=avail "${MONGBAS_RUNTIME_DIR}" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
  [[ "${current_available_bytes}" =~ ^[0-9]+$ ]] || die "could not measure available bytes while workload is running"
  current_mem_available_bytes="$(( $(awk '$1 == "MemAvailable:" { print $2 }' /proc/meminfo) * 1024 ))"
  current_swap_free_bytes="$(( $(awk '$1 == "SwapFree:" { print $2 }' /proc/meminfo) * 1024 ))"
  current_oom_kills="$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)"
  printf '%s\t%s\t%s\trunning\n' "${observed_at}" \
    "${current_available_bytes}" "${minimum_free_bytes}" >>"${out}/disk-monitor.tsv"
  if [ "${current_available_bytes}" -lt "${minimum_free_bytes}" ]; then
    printf '%s\t%s\t%s\tthreshold-breached\n' "${observed_at}" \
      "${current_available_bytes}" "${minimum_free_bytes}" >>"${out}/disk-monitor.tsv"
    disk_abort=1
    abort_reason="disk-below-minimum"
  elif [ "${current_oom_kills}" -gt "${baseline_oom_kills}" ]; then
    abort_reason="kernel-oom-kill-observed"
  elif [ "${current_mem_available_bytes}" -lt "${minimum_mem_available_bytes}" ]; then
    abort_reason="memory-below-minimum"
  fi

  container_failure=""
  for item in "${targets[@]}"; do
    IFS='|' read -r name _ _ <<<"${item}"
    if [ "$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null)" != running ]; then
      container_failure="${name}"
      abort_reason="container-not-running:${name}"
      break
    fi
  done
  health="unavailable"
  if curl --silent --fail --max-time 10 http://127.0.0.1:3002/health | node -e '
    const v=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(v.status === "ok" && v.benchmark?.rateLimitsDisabled === true ? 0 : 1);
  ' >/dev/null 2>&1; then
    health="healthy"
    health_seen=1
  elif [ "${health_seen}" -eq 1 ] || [ "${SECONDS}" -ge "${health_grace_deadline}" ]; then
    abort_reason="fabric-health-unavailable"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${observed_at}" "${current_mem_available_bytes}" \
    "${current_swap_free_bytes}" "${current_oom_kills}" "${health}" "${abort_reason:-running}" >>"${out}/resource-monitor.tsv"
  if [ -n "${abort_reason}" ]; then
    printf '%s\n' "${abort_reason}" >"${out}/abort-reason.txt"
    stop_workload
    break
  fi
  sleep "${disk_sample_seconds}"
done
set +e
wait "${workload_pid}"
workload_status=$?
set -e
workload_pid=""
trap - EXIT INT TERM
if [ "${disk_abort}" -eq 1 ]; then
  workload_status=75
  printf '%s\n' 'disk safety threshold breached; workload process group terminated' >>"${out}/workload.stderr.log"
elif [ -n "${abort_reason}" ]; then
  workload_status=75
  printf 'safety monitor aborted workload: %s\n' "${abort_reason}" >>"${out}/workload.stderr.log"
elif [ "${workload_status}" -eq 137 ]; then
  printf '%s\n' 'workload exited 137; possible OOM or forced kill' >"${out}/abort-reason.txt"
fi
printf '%s\n' "${workload_status}" >"${out}/workload.exit-status.txt"
docker ps --no-trunc --size >"${out}/containers-after.txt"
set +e
snapshot "${out}/storage-after.tsv" 2>"${out}/storage-after.stderr.log"
snapshot_status=$?
set -e
printf '%s\n' "${snapshot_status}" >"${out}/storage-after.exit-status.txt"

if [ "${snapshot_status}" -eq 0 ]; then
  node "${MONGBAS_REPO_DIR}/application/benchmark/summarize-state-growth.js" \
    "${out}/storage-before.tsv" "${out}/storage-after.tsv" "${ballots}" "${out}/state-growth-summary.json"
else
  printf '%s\n' 'post-run storage snapshot incomplete; no growth summary produced' >"${out}/state-growth-summary-error.txt"
fi
printf '{"schema":"mongbas-state-growth-evaluation/v1","ballots":%s,"offeredRate":%s,"durationSeconds":%s,"workloadExitStatus":%s,"gitCommit":"%s"}\n' \
  "${ballots}" "${rate}" "${duration}" "${workload_status}" "$(cat "${out}/git-commit.txt")" >"${out}/metadata.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "state-growth evidence saved to ${out}"
[ "${workload_status}" -eq 0 ] || die "state-growth workload failed; evidence retained"
[ "${snapshot_status}" -eq 0 ] || die "post-run storage snapshot failed; evidence retained"
