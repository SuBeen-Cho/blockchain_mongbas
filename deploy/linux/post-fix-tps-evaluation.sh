#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd df
require_cmd docker
require_cmd node
require_cmd pgrep
require_cmd setsid
require_cmd sha256sum

[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for post-fix TPS evaluation"

if pgrep -af '[s]tate-growth-evaluation\.sh|[r]ate-evaluation\.sh|[v]erifier-evaluation\.sh|[e]lgamal-rate-bench\.js' >/dev/null 2>&1; then
  die "another state-growth, rate, or verifier workload is active"
fi

rates="${MONGBAS_TPS_RATES:-1,5,10,25,50}"
duration="${MONGBAS_TPS_DURATION_SECONDS:-60}"
repeats="${MONGBAS_TPS_REPEATS:-3}"
sample_seconds="${MONGBAS_TPS_SAMPLE_SECONDS:-30}"
minimum_free_bytes="${MONGBAS_TPS_MIN_FREE_BYTES:-60000000000}"
minimum_start_bytes="${MONGBAS_TPS_MIN_START_BYTES:-80000000000}"
minimum_mem_available_bytes="${MONGBAS_TPS_MIN_MEM_AVAILABLE_BYTES:-536870912}"

[[ "${rates}" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "TPS rates must be comma-separated positive integers"
IFS=',' read -r -a rate_values <<<"${rates}"
for rate in "${rate_values[@]}"; do
  [ "${rate}" -ge 1 ] && [ "${rate}" -le 200 ] || die "each TPS rate must be 1..200"
done
[[ "${duration}" =~ ^[0-9]+$ ]] && [ "${duration}" -ge 30 ] && [ "${duration}" -le 600 ] ||
  die "TPS duration must be 30..600 seconds"
[[ "${repeats}" =~ ^[0-9]+$ ]] && [ "${repeats}" -ge 2 ] && [ "${repeats}" -le 10 ] ||
  die "TPS repeats must be 2..10"
[[ "${sample_seconds}" =~ ^[0-9]+$ ]] && [ "${sample_seconds}" -ge 5 ] && [ "${sample_seconds}" -le 60 ] ||
  die "TPS sample interval must be 5..60 seconds"
[[ "${minimum_free_bytes}" =~ ^[0-9]+$ ]] && [ "${minimum_free_bytes}" -ge 5000000000 ] ||
  die "TPS minimum free bytes must be at least 5000000000"
[[ "${minimum_start_bytes}" =~ ^[0-9]+$ ]] && [ "${minimum_start_bytes}" -gt "${minimum_free_bytes}" ] ||
  die "TPS start bytes must exceed the emergency free-space floor"
[[ "${minimum_mem_available_bytes}" =~ ^[0-9]+$ ]] && [ "${minimum_mem_available_bytes}" -ge 268435456 ] &&
  [ "${minimum_mem_available_bytes}" -le 4294967296 ] || die "TPS available-memory floor must be 256MiB..4GiB"

stamp="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/post-fix-tps-${stamp}"
(umask 077; mkdir "${out}" "${out}/rate-results")
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "post-fix TPS evaluation requires a clean worktree"

available_bytes="$(df -B1 --output=avail "${MONGBAS_RUNTIME_DIR}" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
[[ "${available_bytes}" =~ ^[0-9]+$ ]] || die "could not measure available runtime filesystem bytes"
[ "${available_bytes}" -ge "${minimum_start_bytes}" ] ||
  die "insufficient start headroom: require ${minimum_start_bytes} bytes, have ${available_bytes}"
printf 'actualAvailableBytes\tminimumStartBytes\tminimumFreeBytes\n%s\t%s\t%s\n' \
  "${available_bytes}" "${minimum_start_bytes}" "${minimum_free_bytes}" >"${out}/disk-preflight.tsv"

docker ps --format '{{.ID}}\t{{.Image}}\t{{.Names}}' | sort >"${out}/containers-before.tsv"
docker volume ls -q | sort >"${out}/volumes-before.txt"
printf 'timestampUtc\tavailableBytes\tmemAvailableBytes\tswapFreeBytes\toomKillCount\thealth\tevent\n' \
  >"${out}/resource-monitor.tsv"
baseline_oom_kills="$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)"
[[ "${baseline_oom_kills}" =~ ^[0-9]+$ ]] || die "could not read kernel OOM counter"

workload_pid=""
abort_reason=""
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
trap stop_workload EXIT INT TERM

setsid env MONGBAS_RUNTIME_DIR="${MONGBAS_RUNTIME_DIR}" MONGBAS_PROFILE=benchmark \
  MONGBAS_RATE_RESULT_ROOT="${out}/rate-results" MONGBAS_RATE_LEVELS="${rates}" \
  MONGBAS_RATE_DURATION_SECONDS="${duration}" MONGBAS_RATE_REPEATS="${repeats}" \
  "${LINUX_DEPLOY_DIR}/rate-evaluation.sh" >"${out}/workload.stdout.log" 2>"${out}/workload.stderr.log" &
workload_pid=$!

while kill -0 "${workload_pid}" 2>/dev/null; do
  observed_at="$(date -u +%FT%TZ)"
  current_available_bytes="$(df -B1 --output=avail "${MONGBAS_RUNTIME_DIR}" | awk 'NR == 2 { gsub(/[[:space:]]/, "", $0); print }')"
  current_mem_available_bytes="$(( $(awk '$1 == "MemAvailable:" { print $2 }' /proc/meminfo) * 1024 ))"
  current_swap_free_bytes="$(( $(awk '$1 == "SwapFree:" { print $2 }' /proc/meminfo) * 1024 ))"
  current_oom_kills="$(awk '$1 == "oom_kill" { print $2 }' /proc/vmstat)"
  health=healthy
  if [ "${current_available_bytes}" -lt "${minimum_free_bytes}" ]; then
    abort_reason=disk-below-minimum
  elif [ "${current_mem_available_bytes}" -lt "${minimum_mem_available_bytes}" ]; then
    abort_reason=memory-below-minimum
  elif [ "${current_oom_kills}" -gt "${baseline_oom_kills}" ]; then
    abort_reason=kernel-oom-kill-observed
  elif ! "${LINUX_DEPLOY_DIR}/healthcheck.sh" >/dev/null 2>&1 ||
       ! curl --silent --fail --max-time 10 http://127.0.0.1:3000/health | node -e '
         const value=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
         process.exit(value.status === "ok" ? 0 : 1);
       ' >/dev/null 2>&1; then
    health=unavailable
    abort_reason=fabric-health-unavailable
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${observed_at}" "${current_available_bytes}" \
    "${current_mem_available_bytes}" "${current_swap_free_bytes}" "${current_oom_kills}" \
    "${health}" "${abort_reason:-running}" >>"${out}/resource-monitor.tsv"
  if [ -n "${abort_reason}" ]; then
    printf '%s\n' "${abort_reason}" >"${out}/abort-reason.txt"
    stop_workload
    break
  fi
  sleep "${sample_seconds}"
done

set +e
wait "${workload_pid}"
workload_status=$?
set -e
workload_pid=""
trap - EXIT INT TERM
[ -z "${abort_reason}" ] || workload_status=75
printf '%s\n' "${workload_status}" >"${out}/workload.exit-status.txt"

docker ps --format '{{.ID}}\t{{.Image}}\t{{.Names}}' | sort >"${out}/containers-after.tsv"
docker volume ls -q | sort >"${out}/volumes-after.txt"
cmp -s "${out}/containers-before.tsv" "${out}/containers-after.tsv" ||
  printf '%s\n' container-identity-changed >"${out}/topology-warning.txt"
cmp -s "${out}/volumes-before.txt" "${out}/volumes-after.txt" ||
  printf '%s\n' volume-inventory-changed >>"${out}/topology-warning.txt"
curl --silent --show-error --fail http://127.0.0.1:3000/health >"${out}/normal-backend-final-health.json"
printf '{"schema":"mongbas-post-fix-tps-evaluation/v1","rates":"%s","durationSeconds":%s,"repeats":%s,"workloadExitStatus":%s,"abortReason":"%s"}\n' \
  "${rates}" "${duration}" "${repeats}" "${workload_status}" "${abort_reason}" >"${out}/metadata.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
  >"${out}/sha256-inventory.txt"
log "post-fix TPS evidence saved to ${out}"

[ "${workload_status}" -eq 0 ] || die "post-fix TPS workload failed or was safely aborted; evidence retained"
[ ! -f "${out}/topology-warning.txt" ] || die "runtime topology changed during post-fix TPS evaluation"
