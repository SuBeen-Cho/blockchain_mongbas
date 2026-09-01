#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark to avoid mixing demo and benchmark evidence"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/benchmark-${run_id}"
install -d -m 0700 "${out}"
"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 > "${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD > "${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "benchmark requires a clean worktree"
bench_n="${MONGBAS_BENCH_N:-100}"
bench_warmup="${MONGBAS_BENCH_WARMUP:-10}"
set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/elgamal-e2e-bench.js" \
  --url "${MONGBAS_BENCH_URL:-http://127.0.0.1:3000}" \
  --n "${bench_n}" --warmup "${bench_warmup}" --out "${out}/elgamal-report.json" \
  2>&1 | tee "${out}/elgamal-benchmark.log"
benchmark_status="${PIPESTATUS[0]}"
set -e
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) > "${out}/sha256-inventory.txt"
log "benchmark evidence saved to ${out}"
[ "${benchmark_status}" -eq 0 ] || die "benchmark failed (exit ${benchmark_status}); diagnostic evidence retained in ${out}"
