#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd docker
require_cmd node
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for longevity evaluation"

kind="${MONGBAS_LONGEVITY_KIND:-steady}"
case "${kind}" in
  steady) default_duration=1800 ;;
  soak) default_duration=7200 ;;
  *) die "MONGBAS_LONGEVITY_KIND must be steady or soak" ;;
esac
duration="${MONGBAS_LONGEVITY_SECONDS:-${default_duration}}"
concurrency="${MONGBAS_LONGEVITY_CONCURRENCY:-10}"
port="${MONGBAS_LONGEVITY_PORT:-3001}"
[[ "${duration}" =~ ^[0-9]+$ ]] && [ "${duration}" -ge 60 ] || die "longevity duration must be an integer >= 60 seconds"
[[ "${concurrency}" =~ ^[0-9]+$ ]] && [ "${concurrency}" -ge 1 ] && [ "${concurrency}" -le 1000 ] || die "concurrency must be 1..1000"
[[ "${port}" =~ ^[0-9]+$ ]] && [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || die "port must be 1024..65535"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/${kind}-${run_id}"
round_dir="${out}/rounds"
install -d -m 0700 "${out}" "${round_dir}"
backend_pid=""

stop_benchmark_backend() {
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
  backend_pid=""
}
trap stop_benchmark_backend EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ss -H -ltn "sport = :${port}" | grep -q .; then
  die "benchmark port ${port} is already in use"
fi

"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
public_commit="$(git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD)"
printf '%s\n' "${public_commit}" >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "longevity evaluation requires a clean worktree"

baseline_container_count="$(docker ps -q | wc -l)"
(
  cd "${MONGBAS_REPO_DIR}/application"
  exec env PORT="${port}" DISABLE_RATE_LIMITS=true node src/app.js
) >"${out}/benchmark-backend.log" 2>&1 &
backend_pid=$!
printf '%s\n' "${backend_pid}" >"${out}/benchmark-backend.pid.txt"

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:${port}/health" | node -e '
    const value=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(value.status === "ok" && value.benchmark?.rateLimitsDisabled === true ? 0 : 1);
  ' >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "${backend_pid}" 2>/dev/null || break
  sleep 1
done
[ "${ready}" -eq 1 ] || die "isolated benchmark backend did not become ready"

MONGBAS_PROBE_URL="http://127.0.0.1:${port}" node "${MONGBAS_REPO_DIR}/application/scripts/fault-probe.js" \
  >"${out}/baseline-exact.json" 2>"${out}/baseline-exact.stderr.log" || die "baseline exact probe failed"

started_epoch="$(date +%s)"
started_iso="$(date --iso-8601=seconds)"
round=0
run_failed=0
printf 'timestampUtc\tround\telapsedSeconds\tbackendRssKiB\trunningContainers\ttotalContainers\tdiskAvailableKiB\n' >"${out}/resource-samples.tsv"
while [ "$(( $(date +%s) - started_epoch ))" -lt "${duration}" ]; do
  round=$((round + 1))
  label="$(printf 'round-%05d' "${round}")"
  log "${kind} ${label}: C=${concurrency}"
  set +e
  node "${MONGBAS_REPO_DIR}/application/benchmark/elgamal-concurrency-bench.js" \
    --url "http://127.0.0.1:${port}" --conc "${concurrency}" --stopFailRate 1 \
    --out "${round_dir}/${label}.json" >"${round_dir}/${label}.log" 2>&1
  round_status=$?
  set -e
  printf '%s\n' "${round_status}" >"${round_dir}/${label}.exit-status.txt"
  rss_kib="$(awk '/^VmRSS:/ {print $2}' "/proc/${backend_pid}/status" 2>/dev/null || printf '0')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "${round}" \
    "$(( $(date +%s) - started_epoch ))" "${rss_kib:-0}" "$(docker ps -q | wc -l)" "$(docker ps -aq | wc -l)" \
    "$(df -Pk "${MONGBAS_RUNTIME_DIR}" | awk 'NR==2 {print $4}')" >>"${out}/resource-samples.tsv"
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}\t{{.NetIO}}' \
    >"${round_dir}/${label}-docker-stats.tsv"
  docker ps -a --format '{{.Names}}\t{{.Status}}' >"${round_dir}/${label}-docker-ps.tsv"
  if [ "${round_status}" -ne 0 ] || ! kill -0 "${backend_pid}" 2>/dev/null; then
    run_failed=1
    break
  fi
done

finished_epoch="$(date +%s)"
finished_iso="$(date --iso-8601=seconds)"
actual_duration="$(( finished_epoch - started_epoch ))"
set +e
MONGBAS_PROBE_URL="http://127.0.0.1:${port}" node "${MONGBAS_REPO_DIR}/application/scripts/fault-probe.js" \
  >"${out}/final-exact.json" 2>"${out}/final-exact.stderr.log"
final_probe_status=$?
set -e
printf '%s\n' "${final_probe_status}" >"${out}/final-exact.exit-status.txt"

printf '{"kind":"%s","startedAt":"%s","finishedAt":"%s","targetDurationSeconds":%s,"actualDurationSeconds":%s,"concurrency":%s,"publicCommit":"%s"}\n' \
  "${kind}" "${started_iso}" "${finished_iso}" "${duration}" "${actual_duration}" "${concurrency}" "${public_commit}" >"${out}/metadata.json"
set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/summarize-longevity.js" "${round_dir}" "${out}/longevity-report.json" "${out}/metadata.json" \
  >"${out}/summary.stdout.log" 2>"${out}/summary.stderr.log"
summary_status=$?
set -e
printf '%s\n' "${summary_status}" >"${out}/summary.exit-status.txt"

stop_benchmark_backend
curl --silent --show-error --fail 'http://127.0.0.1:3000/health' >"${out}/normal-backend-final-health.json"
final_container_count="$(docker ps -q | wc -l)"
printf 'baseline=%s\nfinal=%s\n' "${baseline_container_count}" "${final_container_count}" >"${out}/container-counts.txt"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "${kind} evidence saved to ${out}"

[ "${run_failed}" -eq 0 ] || die "${kind} round failed; evidence retained"
[ "${final_probe_status}" -eq 0 ] || die "${kind} final exact probe failed; evidence retained"
[ "${summary_status}" -eq 0 ] || die "${kind} strict summary validation failed; evidence retained"
[ "${final_container_count}" -eq "${baseline_container_count}" ] || die "container count changed during ${kind} evaluation"
