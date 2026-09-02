#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd git
require_cmd node

base_url="${MONGBAS_BASE_URL:-http://127.0.0.1:3000}"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/web-security-${run_id}"
install -d -m 0700 "${out}"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "web security evidence requires a clean worktree"

capture() {
  local label="$1"; shift
  curl --silent --show-error --max-time 15 --dump-header "${out}/${label}.headers" \
    --output "${out}/${label}.body" --write-out '%{http_code}' "$@" \
    >"${out}/${label}.status"
}

status_is() {
  local label="$1" expected="$2" actual
  actual="$(cat "${out}/${label}.status")"
  [ "${actual}" = "${expected}" ] || die "${label}: expected HTTP ${expected}, got ${actual}"
}

header_value() {
  local file="$1" name="$2"
  tr -d '\r' <"${file}" | awk -F': ' -v wanted="${name}" 'tolower($1)==tolower(wanted) { value=$2 } END { print value }'
}

require_header() {
  local label="$1" name="$2" expected="$3" actual
  actual="$(header_value "${out}/${label}.headers" "${name}")"
  [ "${actual}" = "${expected}" ] || die "${label}: ${name} mismatch"
}

require_policy_fragment() {
  local label="$1" fragment="$2" actual
  actual="$(header_value "${out}/${label}.headers" 'Content-Security-Policy')"
  [[ "${actual}" == *"${fragment}"* ]] || die "${label}: CSP lacks ${fragment}"
}

require_json_error() {
  local label="$1" expected="$2"
  node -e 'const fs=require("node:fs"); const body=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (body.error !== process.argv[2] || Object.keys(body).length !== 1) process.exit(1)' \
    "${out}/${label}.body" "${expected}" || die "${label}: unexpected error response"
}

capture root "${base_url}/"
status_is root 200
asset_path="$(sed -nE 's/.*src="([^" ]*\/assets\/[^" ]+\.js)".*/\1/p' "${out}/root.body" | sed -n '1p')"
[ -n "${asset_path}" ] || die "built voter UI JavaScript asset was not found"
capture asset "${base_url}${asset_path}"
status_is asset 200
capture health "${base_url}/health"
status_is health 200
capture credential-public-key "${base_url}/api/credential/public-key"
status_is credential-public-key 200

for label in root asset health; do
  require_header "${label}" X-Content-Type-Options nosniff
  require_header "${label}" X-Frame-Options DENY
  require_header "${label}" Referrer-Policy no-referrer
  require_header "${label}" Cross-Origin-Opener-Policy same-origin
  [ -z "$(header_value "${out}/${label}.headers" X-Powered-By)" ] || die "${label}: framework fingerprint exposed"
  require_policy_fragment "${label}" "default-src 'self'"
  require_policy_fragment "${label}" "base-uri 'none'"
  require_policy_fragment "${label}" "object-src 'none'"
  require_policy_fragment "${label}" "frame-ancestors 'none'"
done
require_header credential-public-key Cache-Control no-store
require_header credential-public-key Pragma no-cache

allowed_origin="${CORS_ORIGIN%%,*}"
allowed_origin="$(printf '%s' "${allowed_origin}" | awk '{$1=$1};1')"
[ -n "${allowed_origin}" ] || die "CORS_ORIGIN has no exact origin"
capture cors-allowed -H "Origin: ${allowed_origin}" "${base_url}/health"
status_is cors-allowed 200
require_header cors-allowed Access-Control-Allow-Origin "${allowed_origin}"

capture cors-denied -H 'Origin: https://attacker.invalid' -H 'Content-Type: application/json' \
  --data '{}' "${base_url}/api/elections"
status_is cors-denied 403
capture cross-site-denied -H 'Sec-Fetch-Site: cross-site' -H 'Content-Type: application/json' \
  --data '{}' "${base_url}/api/elections"
status_is cross-site-denied 403
capture simple-mutation-denied -H 'Content-Type: text/plain' --data '{}' "${base_url}/api/elections"
status_is simple-mutation-denied 415
capture admin-missing -H 'Content-Type: application/json' --data '{}' "${base_url}/api/elections"
status_is admin-missing 401
capture trustee-share-missing "${base_url}/api/elections/test/shares/1"
status_is trustee-share-missing 401
capture demo-disabled "${base_url}/api/elections/test/live-count"
status_is demo-disabled 404

capture malformed-json -H 'Content-Type: application/json' --data-binary '{"broken":' \
  "${base_url}/api/elections"
status_is malformed-json 400
require_json_error malformed-json '잘못된 JSON 요청입니다.'

oversized_payload="$(mktemp "${MONGBAS_RUNTIME_DIR}/tmp/web-security-oversized.XXXXXX")"
trap 'rm -f -- "${oversized_payload}"' EXIT
node -e 'process.stdout.write(JSON.stringify({payload:"x".repeat(1024*1024)}))' >"${oversized_payload}"
capture oversized-json -H 'Content-Type: application/json' --data-binary "@${oversized_payload}" \
  "${base_url}/api/elections"
status_is oversized-json 413
require_json_error oversized-json '요청 본문이 허용 크기를 초과했습니다.'
rm -f -- "${oversized_payload}"
trap - EXIT

for label in malformed-json oversized-json; do
  require_header "${label}" X-Content-Type-Options nosniff
  require_header "${label}" Cache-Control no-store
  require_header "${label}" Pragma no-cache
  [ -z "$(header_value "${out}/${label}.headers" X-Powered-By)" ] || die "${label}: framework fingerprint exposed"
done

node - "${out}" "${base_url}" "${allowed_origin}" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [out, baseURL, origin] = process.argv.slice(2);
const labels = ['root', 'asset', 'health', 'credential-public-key', 'cors-allowed', 'cors-denied',
  'cross-site-denied', 'simple-mutation-denied', 'admin-missing', 'trustee-share-missing', 'demo-disabled',
  'malformed-json', 'oversized-json'];
const statuses = Object.fromEntries(labels.map(label => [label, Number(fs.readFileSync(path.join(out, `${label}.status`), 'utf8'))]));
const health = JSON.parse(fs.readFileSync(path.join(out, 'health.body'), 'utf8'));
const summary = {
  schema: 'mongbas-web-security-evaluation/v1',
  baseURL,
  originSha256: crypto.createHash('sha256').update(origin).digest('hex'),
  statuses,
  demoEndpointsEnabled: health.demo?.endpointsEnabled,
  rateLimitsDisabled: health.benchmark?.rateLimitsDisabled,
  staticSecurityHeadersPassed: true,
  frameworkFingerprintAbsent: true,
  corsAndRequestShapePassed: true,
  adminAndTrusteeAuthorizationPassed: true,
  sensitiveCachePolicyPassed: true,
  parserFailurePolicyPassed: statuses['malformed-json'] === 400 && statuses['oversized-json'] === 413,
  securityGatePassed: health.demo?.endpointsEnabled === false && health.benchmark?.rateLimitsDisabled === false,
};
summary.securityGatePassed = summary.securityGatePassed && summary.parserFailurePolicyPassed;
fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
if (!summary.securityGatePassed) process.exit(1);
NODE

(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "web security evidence saved to ${out}"
