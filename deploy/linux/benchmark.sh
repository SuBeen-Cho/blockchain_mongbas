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
npm --prefix "${MONGBAS_REPO_DIR}/application" run bench:elgamal \
  2>&1 | tee "${out}/elgamal-benchmark.log"
log "benchmark evidence saved to ${out}"
