#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd git
require_cmd node
require_cmd npm
require_cmd sha256sum
require_cmd ss

[ "${ENABLE_DEMO_CREDENTIALS:-false}" = true ] || die "full E2E requires explicit demo credentials"
port="${MONGBAS_FULL_E2E_PORT:-3006}"
[[ "${port}" =~ ^[0-9]+$ ]] && [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || die "port must be 1024..65535"
base_url="http://127.0.0.1:${port}"
ss -H -ltn "sport = :${port}" | grep -q . && die "full E2E port ${port} is already in use"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/full-e2e-${run_id}"
install -d -m 0700 "${out}"
backend_pid=""

stop_backend() {
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
  backend_pid=""
}
trap stop_backend EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "full E2E evaluation requires a clean worktree"

(
  cd "${MONGBAS_REPO_DIR}/application"
  exec env PORT="${port}" DISABLE_RATE_LIMITS=true ENABLE_DEMO_ENDPOINTS=false node src/app.js
) >"${out}/evaluation-backend.log" 2>&1 &
backend_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail --max-time 10 "${base_url}/health" | node -e '
    const v=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(v.status === "ok" && v.benchmark?.rateLimitsDisabled === true &&
      v.demo?.endpointsEnabled === false && v.idemix?.enabled === true ? 0 : 1);
  ' >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "${backend_pid}" 2>/dev/null || break
  sleep 1
done
[ "${ready}" -eq 1 ] || die "isolated full E2E backend did not become ready: ${base_url}"

started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
set +e
E2E_BASE_URL="${base_url}" node "${MONGBAS_REPO_DIR}/application/scripts/full-election-e2e.js" \
  >"${out}/evaluation.stdout.log" 2>"${out}/evaluation.stderr.log"
status=$?
set -e
ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf '%s\n' "${status}" >"${out}/evaluation.exit-status.txt"

stop_backend
ss -H -ltn "sport = :${port}" | grep -q . && die "isolated full E2E backend still owns port ${port} after cleanup"
printf '{"schema":"mongbas-full-e2e-evaluation/v1","startedAt":"%s","endedAt":"%s","baseURL":"%s","exitStatus":%d,"gitCommit":"%s"}\n' \
  "${started_at}" "${ended_at}" "${base_url}" "${status}" "$(cat "${out}/git-commit.txt")" >"${out}/metadata.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"

log "full E2E evidence saved to ${out}"
[ "${status}" -eq 0 ] || die "full E2E failed (exit ${status}); evidence retained"
