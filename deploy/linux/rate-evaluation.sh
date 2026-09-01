#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd docker
require_cmd node
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for fixed-rate evaluation"

rates="${MONGBAS_RATE_LEVELS:-1,5,10,25,50}"
duration="${MONGBAS_RATE_DURATION_SECONDS:-60}"
repeats="${MONGBAS_RATE_REPEATS:-1}"
port="${MONGBAS_RATE_PORT:-3002}"
[[ "${duration}" =~ ^[0-9]+$ ]] && [ "${duration}" -ge 5 ] && [ "${duration}" -le 3600 ] || die "duration must be 5..3600 seconds"
[[ "${repeats}" =~ ^[0-9]+$ ]] && [ "${repeats}" -ge 1 ] && [ "${repeats}" -le 20 ] || die "repeats must be 1..20"
[[ "${port}" =~ ^[0-9]+$ ]] && [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || die "port must be 1024..65535"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/rate-${run_id}"
install -d -m 0700 "${out}"
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

ss -H -ltn "sport = :${port}" | grep -q . && die "benchmark port ${port} is already in use"
"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "fixed-rate evaluation requires a clean worktree"
baseline_container_count="$(docker ps -q | wc -l)"

(
  cd "${MONGBAS_REPO_DIR}/application"
  exec env PORT="${port}" DISABLE_RATE_LIMITS=true node src/app.js
) >"${out}/benchmark-backend.log" 2>&1 &
backend_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:${port}/health" | node -e '
    const v=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(v.status === "ok" && v.benchmark?.rateLimitsDisabled === true && v.idemix?.enabled === true ? 0 : 1);
  ' >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "${backend_pid}" 2>/dev/null || break
  sleep 1
done
[ "${ready}" -eq 1 ] || die "isolated credential-enabled benchmark backend did not become ready"

set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/elgamal-rate-bench.js" \
  --url "http://127.0.0.1:${port}" --rates "${rates}" --duration "${duration}" --repeats "${repeats}" \
  --out "${out}/rate-report.json" >"${out}/rate-benchmark.log" 2>&1
benchmark_status=$?
set -e
printf '%s\n' "${benchmark_status}" >"${out}/benchmark-exit-status.txt"

set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/summarize-rate.js" \
  "${out}/rate-report.json" "${out}/rate-summary.json" >"${out}/summary.stdout.log" 2>"${out}/summary.stderr.log"
summary_status=$?
set -e
printf '%s\n' "${summary_status}" >"${out}/summary-exit-status.txt"

stop_benchmark_backend
curl --silent --show-error --fail 'http://127.0.0.1:3000/health' >"${out}/normal-backend-final-health.json"
final_container_count="$(docker ps -q | wc -l)"
printf 'baseline=%s\nfinal=%s\n' "${baseline_container_count}" "${final_container_count}" >"${out}/container-counts.txt"
find "${out}" -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum >"${out}/sha256-inventory.txt"
log "fixed-rate evidence saved to ${out}"

[ "${benchmark_status}" -eq 0 ] || die "fixed-rate benchmark failed; evidence retained"
[ "${summary_status}" -eq 0 ] || die "fixed-rate strict summary failed; evidence retained"
[ "${final_container_count}" -eq "${baseline_container_count}" ] || die "container count changed during fixed-rate evaluation"
