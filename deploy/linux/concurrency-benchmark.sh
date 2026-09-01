#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark"
levels="${MONGBAS_CONCURRENCY_LEVELS:-1,5,10,25,50}"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/concurrency-${run_id}"
install -d -m 0700 "${out}"
"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 > "${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD > "${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "benchmark requires a clean worktree"

set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/elgamal-concurrency-bench.js" \
  --url "${MONGBAS_BENCH_URL:-http://127.0.0.1:3000}" \
  --conc "${levels}" \
  --stopFailRate "${MONGBAS_STOP_FAIL_RATE:-30}" \
  --out "${out}/concurrency-report.json" \
  2>&1 | tee "${out}/concurrency-benchmark.log"
benchmark_status="${PIPESTATUS[0]}"
set -e
find "${out}" -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum > "${out}/sha256-inventory.txt"
log "concurrency evidence saved to ${out}"
[ "${benchmark_status}" -eq 0 ] || die "concurrency benchmark failed (exit ${benchmark_status}); evidence retained in ${out}"
