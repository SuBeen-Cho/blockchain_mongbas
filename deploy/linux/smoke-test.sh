#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
base_url="${MONGBAS_BASE_URL:-http://127.0.0.1:3000}"
curl --fail --silent --show-error --max-time 10 "${base_url}/api/health" >/dev/null
E2E_BASE_URL="${base_url}" npm --prefix "${MONGBAS_REPO_DIR}/application" run e2e:full \
  2>&1 | tee "${MONGBAS_LOG_DIR}/e2e-$(timestamp_utc).log"
log "smoke/E2E completed with a zero exit status"
