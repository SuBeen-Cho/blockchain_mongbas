#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd git
require_cmd node
require_cmd sha256sum

[ "${ENABLE_DEMO_CREDENTIALS:-false}" = "true" ] || die "revocation evaluation requires explicit demo credentials"
base_url="${E2E_BASE_URL:-http://127.0.0.1:3000}"
[[ "${base_url}" =~ ^https?://[A-Za-z0-9._:-]+$ ]] || die "E2E_BASE_URL must be an origin without path/query/userinfo"
curl --fail --silent --show-error --max-time 10 "${base_url}/health" >/dev/null || die "backend healthcheck failed: ${base_url}"

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/revocation-${run_id}"
install -d -m 0700 "${out}"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "revocation evaluation requires a clean worktree"

started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
set +e
E2E_BASE_URL="${base_url}" node "${MONGBAS_REPO_DIR}/application/scripts/credential-revocation-e2e.js" \
  >"${out}/evaluation.stdout.log" 2>"${out}/evaluation.stderr.log"
status=$?
set -e
ended_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

printf '%s\n' "${status}" >"${out}/evaluation.exit-status.txt"
printf '{"schema":"mongbas-revocation-evaluation/v1","startedAt":"%s","endedAt":"%s","baseURL":"%s","exitStatus":%d,"gitCommit":"%s"}\n' \
  "${started_at}" "${ended_at}" "${base_url}" "${status}" "$(cat "${out}/git-commit.txt")" \
  >"${out}/metadata.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"

log "revocation evidence saved to ${out}"
[ "${status}" -eq 0 ] || die "revocation evaluation failed; evidence retained"
