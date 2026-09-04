#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd git
require_cmd node
require_cmd npm
require_cmd pgrep
require_cmd realpath
require_cmd sha256sum
require_cmd tar
require_cmd timeout
[ -x /usr/bin/time ] || die "GNU /usr/bin/time is required"
[ "${MONGBAS_PROFILE}" = benchmark ] || die "set MONGBAS_PROFILE=benchmark"

out=""
preserve_exit() {
  local status=$?
  trap - EXIT
  if [ -n "${out}" ] && [ -d "${out}" ]; then
    printf '%s\n' "${status}" >"${out}/run-exit-status.txt"
    [ -f "${out}/finished-at.txt" ] || date -u +%Y-%m-%dT%H:%M:%SZ >"${out}/finished-at.txt"
    if [ ! -f "${out}/sha256-inventory.txt" ]; then
      (cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
        >"${out}/sha256-inventory.txt"
    fi
  fi
  exit "${status}"
}
trap preserve_exit EXIT

baseline_input="${MONGBAS_VERIFIER_BASELINE_RESULT:-}"
[ -n "${baseline_input}" ] || die "set MONGBAS_VERIFIER_BASELINE_RESULT to a completed verifier result"
baseline="$(realpath --canonicalize-existing -- "${baseline_input}")"
result_root="$(realpath --canonicalize-existing -- "${MONGBAS_RESULT_DIR}")"
case "${baseline}" in "${result_root}"/verifier-*) ;; *) die "baseline must be a verifier result below MONGBAS_RESULT_DIR" ;; esac
[ -d "${baseline}" ] && [ ! -L "${baseline_input}" ] || die "baseline must be a non-symlink directory"

if pgrep -f '(^|/)verifier-evaluation\.sh([[:space:]]|$)' >/dev/null; then
  die "refusing to overlap an active verifier-evaluation.sh"
fi

mode="${MONGBAS_VERIFIER_COMPARISON_MODE:-}"
case "${mode}" in sync|parallel) ;; *) die "MONGBAS_VERIFIER_COMPARISON_MODE must be sync or parallel" ;; esac
workers="${MONGBAS_VERIFIER_COMPARISON_WORKERS:-}"
if [ "${mode}" = parallel ]; then
  [[ "${workers}" =~ ^[2-9][0-9]*$ ]] || die "set MONGBAS_VERIFIER_COMPARISON_WORKERS to a canonical integer of at least 2"
elif [ -n "${workers}" ]; then
  die "worker count is forbidden in sync mode"
fi
timeout_seconds="${MONGBAS_VERIFIER_COMPARISON_TIMEOUT_SECONDS:-14400}"
[[ "${timeout_seconds}" =~ ^[0-9]+$ ]] && [ "${timeout_seconds}" -ge 60 ] && [ "${timeout_seconds}" -le 28800 ] || \
  die "MONGBAS_VERIFIER_COMPARISON_TIMEOUT_SECONDS must be 60..28800"

bundle="${baseline}/bundle-signed.json"
mutation="${baseline}/tamper-corpus/proof-changed.json"
inventory="${baseline}/sha256-inventory.txt"
for source_file in "${bundle}" "${mutation}" "${inventory}"; do
  [ -f "${source_file}" ] && [ ! -L "${source_file}" ] || die "baseline source must be a regular non-symlink file"
done

branch="$(git -C "${MONGBAS_REPO_DIR}" branch --show-current)"
[ "${branch}" = feat/ballot-history-consistency ] || die "comparison requires the feature branch"
commit="$(git -C "${MONGBAS_REPO_DIR}" rev-parse --verify HEAD)"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/verifier-preserved-${mode}${workers:+-${workers}}-${run_id}"
[ ! -e "${out}" ] || die "comparison output already exists"
install -d -m 0700 "${out}"

date -u +%Y-%m-%dT%H:%M:%SZ >"${out}/started-at.txt"
printf '%s\n' "${commit}" >"${out}/git-commit.txt"
printf '%s\n' "${branch}" >"${out}/git-branch.txt"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
[ ! -s "${out}/git-status.txt" ] || die "comparison requires a clean worktree"
printf '%s\n' "${baseline}" >"${out}/source-result-directory.txt"
printf '%s\n' "${mode}" >"${out}/comparison-mode.txt"
printf '%s\n' "${workers:-none}" >"${out}/proof-workers.txt"
printf '%s\n' "${timeout_seconds}" >"${out}/timeout-seconds.txt"
(cd "${baseline}" && sha256sum --check sha256-inventory.txt) >"${out}/source-inventory-check.log" 2>"${out}/source-inventory-check.stderr.log" \
  || die "baseline inventory verification failed"
sha256sum "${bundle}" "${mutation}" >"${out}/source-bundle-sha256.txt"

npm pack --silent --pack-destination "${out}" "${MONGBAS_REPO_DIR}/verifier" >"${out}/npm-pack.stdout.log"
package_file="$(find "${out}" -maxdepth 1 -type f -name 'mongbas-election-verifier-*.tgz' -print -quit)"
[ -n "${package_file}" ] || die "verifier npm package was not created"
install -d -m 0700 "${out}/clean-verifier"
tar -xzf "${package_file}" -C "${out}/clean-verifier"
verifier=(node "${out}/clean-verifier/package/bin/mongbas-verify.js")
if [ "${mode}" = parallel ]; then verifier+=(--proof-workers "${workers}"); fi

run_verification() {
  local name="$1" expected="$2" input="$3" status
  set +e
  /usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M\nuserSeconds=%U\nsystemSeconds=%S' -o "${out}/${name}.metrics.txt" \
    timeout --signal=TERM --kill-after=30 "${timeout_seconds}" "${verifier[@]}" "${input}" \
    >"${out}/${name}.stdout.log" 2>"${out}/${name}.stderr.log"
  status=$?
  set -e
  printf '%s\n' "${status}" >"${out}/${name}.exit-status.txt"
  [ "${status}" -eq "${expected}" ] || die "${name} exited ${status}; expected ${expected}"
}

run_verification valid 0 "${bundle}"
run_verification proof-changed 1 "${mutation}"
date -u +%Y-%m-%dT%H:%M:%SZ >"${out}/finished-at.txt"
printf '{"schema":"mongbas-preserved-verifier-comparison/v1","commit":"%s","mode":"%s","workers":"%s","validExit":0,"proofChangedExit":1}\n' \
  "${commit}" "${mode}" "${workers:-none}" >"${out}/run-manifest.json"
printf '0\n' >"${out}/run-exit-status.txt"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
log "preserved verifier comparison saved to ${out}"
