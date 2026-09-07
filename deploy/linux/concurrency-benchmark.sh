#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd pgrep
require_cmd sha256sum
require_cmd ss
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark"
levels="${MONGBAS_CONCURRENCY_LEVELS:-1,5,10,25,50}"
repeats="${MONGBAS_CONCURRENCY_REPEATS:-1}"
port="${MONGBAS_CONCURRENCY_PORT:-3002}"
maximum_voters="$(printf '%s' "${levels}" | tr ',' '\n' | sort -nr | head -1)"
[[ "${maximum_voters}" =~ ^[0-9]+$ ]] && [ "${maximum_voters}" -ge 1 ] && [ "${maximum_voters}" -le 5000 ] || die "concurrency levels must be integers in 1..5000"
[[ "${repeats}" =~ ^[0-9]+$ ]] && [ "${repeats}" -ge 1 ] && [ "${repeats}" -le 10 ] || die "repeats must be 1..10"
[[ "${port}" =~ ^[0-9]+$ ]] && [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || die "port must be 1024..65535"
if pgrep -af '[s]tate-growth-evaluation\.sh|[r]ate-evaluation\.sh|[e]lgamal-rate-bench\.js|[e]lgamal-concurrency-bench\.js' >/dev/null 2>&1; then
  die "another state-growth, rate, or concurrency workload is active"
fi
ss -H -ltn "sport = :${port}" | grep -q . && die "benchmark port ${port} is already in use"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/concurrency-${run_id}"
install -d -m 0700 "${out}"
"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 > "${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD > "${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "benchmark requires a clean worktree"

backend_pid=""
stop_benchmark_backend() {
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
}
trap stop_benchmark_backend EXIT INT TERM
(
  cd "${MONGBAS_REPO_DIR}/application"
  exec env PORT="${port}" DISABLE_RATE_LIMITS=true ENABLE_BENCH_ENDPOINTS=true \
    BENCHMARK_DEMO_VOTER_COUNT="${maximum_voters}" \
    REQUIRE_DEMO_ADMISSION=false node src/app.js
) >"${out}/benchmark-backend.log" 2>&1 &
backend_pid=$!
ready=0
for _attempt in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:${port}/health" | node -e '
    const v=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
    process.exit(v.status === "ok" && v.benchmark?.rateLimitsDisabled === true && v.idemix?.enabled === true ? 0 : 1);
  ' >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "${backend_pid}" 2>/dev/null || break
  sleep 1
done
[ "${ready}" -eq 1 ] || die "isolated concurrency backend did not become ready"

set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/elgamal-concurrency-bench.js" \
  --url "http://127.0.0.1:${port}" \
  --conc "${levels}" \
  --repeats "${repeats}" \
  --stopFailRate "${MONGBAS_STOP_FAIL_RATE:-30}" \
  --out "${out}/concurrency-report.json" \
  2>&1 | tee "${out}/concurrency-benchmark.log"
benchmark_status="${PIPESTATUS[0]}"
set -e
printf '%s\n' "${benchmark_status}" >"${out}/benchmark-exit-status.txt"
stop_benchmark_backend
backend_pid=""
trap - EXIT INT TERM
curl --silent --show-error --fail http://127.0.0.1:3000/health >"${out}/normal-backend-final-health.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) > "${out}/sha256-inventory.txt"
log "concurrency evidence saved to ${out}"
[ "${benchmark_status}" -eq 0 ] || die "concurrency benchmark failed (exit ${benchmark_status}); evidence retained in ${out}"
