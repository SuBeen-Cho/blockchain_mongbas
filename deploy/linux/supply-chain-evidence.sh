#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
require_cmd docker
require_cmd git
require_cmd go
require_cmd node
require_cmd npm

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/supply-chain-${run_id}"
install -d -m 0700 "${out}" "${out}/sbom" "${out}/audit"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "supply-chain evidence requires a clean worktree"

generate_sbom() {
  local label="$1" directory="$2"
  (cd "${directory}" && npm sbom --package-lock-only --omit=optional --sbom-format cyclonedx) >"${out}/sbom/${label}.cdx.json"
  set +e
  (cd "${directory}" && npm audit --omit=optional --json) >"${out}/audit/${label}.json"
  local audit_status=$?
  set -e
  printf '%s\n' "${audit_status}" >"${out}/audit/${label}.exit-status.txt"
}

generate_sbom application "${MONGBAS_REPO_DIR}/application"
generate_sbom frontend "${MONGBAS_REPO_DIR}/frontend"
generate_sbom verifier "${MONGBAS_REPO_DIR}/verifier"

vendor_modules="${MONGBAS_REPO_DIR}/chaincode/voting/vendor/modules.txt"
[ -f "${vendor_modules}" ] || die "vendored Go module inventory is missing: ${vendor_modules}"
awk 'BEGIN { print "module\tversion" } /^# / && NF >= 3 && $2 != "=>" { print $2 "\t" $3 }' \
  "${vendor_modules}" >"${out}/go-modules.tsv"
sha256sum "${vendor_modules}" >"${out}/go-vendor-modules.sha256"
(cd "${MONGBAS_REPO_DIR}/chaincode/voting" && go env -json GOARCH GOOS GOVERSION GOMOD GOSUMDB GOPROXY) >"${out}/go-environment.json"
docker image ls --digests --no-trunc --format '{{json .}}' >"${out}/docker-images.jsonl"

cat >"${out}/validation-manifest.json" <<EOF
{"sboms":{"application":"${out}/sbom/application.cdx.json","frontend":"${out}/sbom/frontend.cdx.json","verifier":"${out}/sbom/verifier.cdx.json"},"audits":{"application":"${out}/audit/application.json","frontend":"${out}/audit/frontend.json","verifier":"${out}/audit/verifier.json"}}
EOF

set +e
node "${MONGBAS_REPO_DIR}/application/benchmark/validate-supply-chain.js" \
  "${out}/validation-manifest.json" "${out}/supply-chain-summary.json" >"${out}/validation.stdout.log" 2>"${out}/validation.stderr.log"
validation_status=$?
set -e
printf '%s\n' "${validation_status}" >"${out}/validation.exit-status.txt"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "supply-chain evidence saved to ${out}"
[ "${validation_status}" -eq 0 ] || die "supply-chain evidence validation failed; evidence retained"
