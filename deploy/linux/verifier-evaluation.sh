#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd base64
require_cmd curl
require_cmd docker
require_cmd node
require_cmd npm
require_cmd openssl
require_cmd ss
require_cmd tar
[ -x /usr/bin/time ] || die "GNU /usr/bin/time is required for verifier resource measurements"
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark for verifier evaluation"

port="${MONGBAS_VERIFIER_EVALUATION_PORT:-3002}"
[[ "${port}" =~ ^[0-9]+$ ]] && [ "${port}" -ge 1024 ] && [ "${port}" -le 65535 ] || die "port must be 1024..65535"
if ss -H -ltn "sport = :${port}" | grep -q .; then die "verifier evaluation port ${port} is already in use"; fi

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/verifier-${run_id}"
install -d -m 0700 "${out}" "${out}/tamper-corpus"
signer_dir="$(mktemp -d "${MONGBAS_SECRET_DIR}/bundle-signers.XXXXXX")"
chmod 0700 "${signer_dir}"
backend_pid=""

stop_backend() {
  if [ -n "${backend_pid}" ] && kill -0 "${backend_pid}" 2>/dev/null; then
    kill "${backend_pid}" 2>/dev/null || true
    wait "${backend_pid}" 2>/dev/null || true
  fi
  backend_pid=""
}
remove_ephemeral_signers() {
  if [ -n "${signer_dir}" ] && [ -d "${signer_dir}" ]; then
    find "${signer_dir}" -type f -exec chmod 0600 {} +
    rm -rf -- "${signer_dir}"
  fi
  signer_dir=""
}
cleanup() { stop_backend; remove_ephemeral_signers; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
commit="$(git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD)"
printf '%s\n' "${commit}" >"${out}/git-commit.txt"
[ ! -s "${out}/git-status.txt" ] || die "verifier evaluation requires a clean worktree"
image_digest="$(docker image inspect voting-chaincode:1.0 --format '{{.Id}}')"
[[ "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "chaincode image ID is not a sha256 digest"

for organization in ec party civil; do
  openssl genpkey -algorithm ED25519 -out "${signer_dir}/${organization}.pem" 2>"${out}/${organization}-keygen.stderr.log"
  chmod 0600 "${signer_dir}/${organization}.pem"
  openssl pkey -in "${signer_dir}/${organization}.pem" -pubout -outform DER 2>>"${out}/${organization}-keygen.stderr.log" | base64 | tr -d '\n' \
    >"${out}/${organization}-public-key.base64"
done
organizations="$(printf '[{"id":"ec","ed25519PublicKeyDer":"%s"},{"id":"party","ed25519PublicKeyDer":"%s"},{"id":"civil","ed25519PublicKeyDer":"%s"}]' \
  "$(cat "${out}/ec-public-key.base64")" "$(cat "${out}/party-public-key.base64")" "$(cat "${out}/civil-public-key.base64")")"

(
  cd "${MONGBAS_REPO_DIR}/application"
  exec env PORT="${port}" DISABLE_RATE_LIMITS=true BUNDLE_ORGANIZATIONS_JSON="${organizations}" BUNDLE_SIGNATURE_THRESHOLD=2 \
    MONGBAS_GIT_COMMIT="${commit}" MONGBAS_IMAGE_DIGEST="${image_digest}" MONGBAS_SOFTWARE_VERSION="1.0.0+${commit}" node src/app.js
) >"${out}/bundle-backend.log" 2>&1 &
backend_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "${backend_pid}" 2>/dev/null || break
  sleep 1
done
[ "${ready}" -eq 1 ] || die "bundle-export backend did not become ready"

election_id="${MONGBAS_VERIFIER_ELECTION_ID:-}"
if [ -z "${election_id}" ]; then
  MONGBAS_PROBE_URL="http://127.0.0.1:${port}" MONGBAS_PROBE_VOTES=3 MONGBAS_PROBE_AUDIT_BALLOTS=1 MONGBAS_PROBE_PUBLISH_AUDIT=true \
    node "${MONGBAS_REPO_DIR}/application/scripts/fault-probe.js" >"${out}/live-election.json" 2>"${out}/live-election.stderr.log" \
    || die "three-ballot live election probe failed"
  election_id="$(node -e 'const value=require(process.argv[1]); if (!/^[A-Za-z0-9._-]+$/.test(value.electionID)) process.exit(1); process.stdout.write(value.electionID)' "${out}/live-election.json")"
else
  [[ "${election_id}" =~ ^[A-Za-z0-9._-]+$ ]] || die "MONGBAS_VERIFIER_ELECTION_ID is invalid"
  printf '{"electionID":"%s","source":"pre-existing"}\n' "${election_id}" >"${out}/live-election.json"
  if [ "${MONGBAS_VERIFIER_PUBLISH_EXISTING_AUDIT:-false}" = true ]; then
    BUNDLE_BASE_URL="http://127.0.0.1:${port}" BUNDLE_ELECTION_ID="${election_id}" \
      /usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/publish-existing-audit.metrics.txt" node -e '
      const base = process.env.BUNDLE_BASE_URL;
      const election = encodeURIComponent(process.env.BUNDLE_ELECTION_ID);
      const token = process.env.ADMIN_API_TOKEN;
      fetch(`${base}/api/elections/${election}/publish-audit`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
      }).then(async response => {
        const text = await response.text();
        process.stdout.write(text);
        if (!response.ok) throw new Error(`publish-audit failed: HTTP ${response.status}`);
      }).catch(error => { console.error(error.message); process.exit(1); });
    ' >"${out}/publish-existing-audit.json" 2>"${out}/publish-existing-audit.stderr.log" \
      || die "existing election audit publication failed"
  elif [ "${MONGBAS_VERIFIER_PUBLISH_EXISTING_AUDIT:-false}" != false ]; then
    die "MONGBAS_VERIFIER_PUBLISH_EXISTING_AUDIT must be true or false"
  fi
fi
/usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/bundle-source.metrics.txt" \
  curl --silent --show-error --fail "http://127.0.0.1:${port}/api/elections/${election_id}/election-bundle-source" \
  >"${out}/bundle-source.json"
stop_backend

/usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/bundle-build.metrics.txt" \
  node "${MONGBAS_REPO_DIR}/verifier/bin/mongbas-bundle.js" build "${out}/bundle-source.json" "${out}/bundle-unsigned.json"
/usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/bundle-sign-ec.metrics.txt" \
  node "${MONGBAS_REPO_DIR}/verifier/bin/mongbas-bundle.js" sign "${out}/bundle-unsigned.json" ec "${signer_dir}/ec.pem" "${out}/bundle-ec.json"
/usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/bundle-sign-party.metrics.txt" \
  node "${MONGBAS_REPO_DIR}/verifier/bin/mongbas-bundle.js" sign "${out}/bundle-ec.json" party "${signer_dir}/party.pem" "${out}/bundle-signed.json"
stat -c '%n\t%s' "${out}/bundle-source.json" "${out}/bundle-unsigned.json" "${out}/bundle-ec.json" \
  "${out}/bundle-signed.json" >"${out}/bundle-sizes.tsv"
remove_ephemeral_signers

npm pack --silent --pack-destination "${out}" "${MONGBAS_REPO_DIR}/verifier" >"${out}/npm-pack.stdout.log"
package_file="$(find "${out}" -maxdepth 1 -type f -name 'mongbas-election-verifier-*.tgz' -print -quit)"
[ -n "${package_file}" ] || die "verifier npm package was not created"
install -d -m 0700 "${out}/clean-verifier"
tar -xzf "${package_file}" -C "${out}/clean-verifier"
set +e
/usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/valid-verification.metrics.txt" \
  node "${out}/clean-verifier/package/bin/mongbas-verify.js" "${out}/bundle-signed.json" \
  >"${out}/valid-verification.stdout.log" 2>"${out}/valid-verification.stderr.log"
valid_status=$?
set -e
printf '%s\n' "${valid_status}" >"${out}/valid-verification.exit-status.txt"
[ "${valid_status}" -eq 0 ] || die "clean-directory verifier rejected the valid live bundle"

node "${out}/clean-verifier/package/bin/mongbas-tamper-corpus.js" "${out}/bundle-signed.json" "${out}/tamper-corpus" \
  >"${out}/tamper-generation.stdout.log" 2>"${out}/tamper-generation.stderr.log"
printf 'case\texitStatus\tverdict\n' >"${out}/tamper-results.tsv"
tamper_failure=0
while IFS= read -r tampered; do
  name="$(basename "${tampered}" .json)"
  set +e
  /usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M' -o "${out}/tamper-corpus/${name}.metrics.txt" \
    node "${out}/clean-verifier/package/bin/mongbas-verify.js" "${tampered}" \
    >"${out}/tamper-corpus/${name}.stdout.log" 2>"${out}/tamper-corpus/${name}.stderr.log"
  status=$?
  set -e
  verdict=pass
  if [ "${status}" -ne 1 ]; then verdict=fail; tamper_failure=1; fi
  printf '%s\t%s\t%s\n' "${name}" "${status}" "${verdict}" >>"${out}/tamper-results.tsv"
done < <(find "${out}/tamper-corpus" -maxdepth 1 -type f -name '*.json' ! -name manifest.json | sort)

printf 'stage\telapsedSeconds\tmaxRssKiB\n' >"${out}/resource-metrics.tsv"
append_metrics() {
  local stage="$1"
  local metrics_file="$2"
  local elapsed max_rss
  [ -f "${metrics_file}" ] || return 0
  elapsed="$(awk -F= '$1 == "elapsedSeconds" { print $2 }' "${metrics_file}")"
  max_rss="$(awk -F= '$1 == "maxRssKiB" { print $2 }' "${metrics_file}")"
  [ -n "${elapsed}" ] && [ -n "${max_rss}" ] || die "incomplete resource metrics: ${metrics_file}"
  printf '%s\t%s\t%s\n' "${stage}" "${elapsed}" "${max_rss}" >>"${out}/resource-metrics.tsv"
}
append_metrics publish-existing-audit "${out}/publish-existing-audit.metrics.txt"
append_metrics bundle-source "${out}/bundle-source.metrics.txt"
append_metrics bundle-build "${out}/bundle-build.metrics.txt"
append_metrics bundle-sign-ec "${out}/bundle-sign-ec.metrics.txt"
append_metrics bundle-sign-party "${out}/bundle-sign-party.metrics.txt"
append_metrics valid-verification "${out}/valid-verification.metrics.txt"
while IFS= read -r metrics_file; do
  append_metrics "tamper:$(basename "${metrics_file}" .metrics.txt)" "${metrics_file}"
done < <(find "${out}/tamper-corpus" -maxdepth 1 -type f -name '*.metrics.txt' | sort)

curl --silent --show-error --fail 'http://127.0.0.1:3000/health' >"${out}/normal-backend-final-health.json"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "verifier evidence saved to ${out}"
[ "${tamper_failure}" -eq 0 ] || die "one or more tampered bundles did not exit exactly 1"
