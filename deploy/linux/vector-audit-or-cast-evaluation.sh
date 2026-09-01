#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd git
require_cmd node
require_cmd sha256sum
require_cmd ss

[ "${ENABLE_DEMO_CREDENTIALS:-false}" = "true" ] || die "vector audit-or-cast evaluation requires explicit demo credentials"
port="${MONGBAS_VECTOR_AOC_PORT:-3003}"
[[ "${port}" =~ ^[0-9]+$ ]] && [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || die "port must be 1024..65535"
base_url="${E2E_BASE_URL:-http://127.0.0.1:${port}}"
[[ "${base_url}" =~ ^https?://[A-Za-z0-9._:-]+$ ]] || die "E2E_BASE_URL must be an origin without path/query/userinfo"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/vector-aoc-${run_id}"
install -d -m 0700 "${out}"
backend_pid=""

stop_evaluation_backend() {
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
  backend_pid=""
}
trap stop_evaluation_backend EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "${E2E_BASE_URL:-}" ]; then
  ss -H -ltn "sport = :${port}" | grep -q . && die "vector audit-or-cast port ${port} is already in use"
  (
    cd "${MONGBAS_REPO_DIR}/application"
    exec env PORT="${port}" DISABLE_RATE_LIMITS=true node src/app.js
  ) >"${out}/evaluation-backend.log" 2>&1 &
  backend_pid=$!
fi

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail --max-time 10 "${base_url}/health" | node -e '
    const v=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(v.status === "ok" && v.benchmark?.rateLimitsDisabled === true && v.idemix?.enabled === true ? 0 : 1);
  ' >/dev/null 2>&1; then ready=1; break; fi
  [ -z "${backend_pid}" ] || kill -0 "${backend_pid}" 2>/dev/null || break
  sleep 1
done
[ "${ready}" -eq 1 ] || die "credential-enabled, rate-limit-disabled evaluation backend did not become ready: ${base_url}"

git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "vector audit-or-cast evaluation requires a clean worktree"

started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
set +e
E2E_BASE_URL="${base_url}" node "${MONGBAS_REPO_DIR}/application/scripts/vector-audit-or-cast-e2e.js" \
  >"${out}/evaluation.stdout.log" 2>"${out}/evaluation.stderr.log"
task_exit=$?
set -e
ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf '%s\n' "${task_exit}" >"${out}/evaluation.exit-status.txt"
stop_evaluation_backend
if [ -z "${E2E_BASE_URL:-}" ]; then
  ss -H -ltn "sport = :${port}" | grep -q . && die "isolated evaluation backend still owns port ${port} after cleanup"
fi
printf '{"schema":"mongbas-vector-audit-or-cast-evaluation/v1","startedAt":"%s","endedAt":"%s","baseURL":"%s","exitStatus":%d,"gitCommit":"%s","claimBoundary":"state-machine E2E; independent bundle verification remains separate"}\n' \
  "${started_at}" "${ended_at}" "${base_url}" "${task_exit}" "$(cat "${out}/git-commit.txt")" >"${out}/metadata.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"

log "vector audit-or-cast evidence saved to ${out}"
[ "${task_exit}" -eq 0 ] || die "vector audit-or-cast evaluation failed; evidence retained"
