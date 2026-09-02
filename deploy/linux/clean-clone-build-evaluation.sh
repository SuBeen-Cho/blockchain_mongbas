#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
require_cmd git
require_cmd node
require_cmd sha256sum

remote_url="${MONGBAS_CLEAN_CLONE_URL:-https://github.com/SuBeen-Cho/blockchain_mongbas.git}"
remote_ref="${MONGBAS_CLEAN_CLONE_REF:-main}"
node -e 'const u=new URL(process.argv[1]); if (u.protocol !== "https:" || u.username || u.password) process.exit(1)' "${remote_url}" \
  || die "clean-clone URL must be credential-free HTTPS"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/clean-clone-build-${run_id}"
workspace="${MONGBAS_RUNTIME_DIR}/clean-clone-workspaces/${run_id}"
clone_dir="${workspace}/repo"
clone_runtime="${workspace}/runtime"
install -d -m 0700 "${out}" "${workspace}"

finish() {
  local rc=$?
  printf '%s\n' "${rc}" >"${out}/exit-code.txt"
  if [ "${rc}" -ne 0 ]; then
    printf '%s\n' false >"${out}/gate-passed.txt"
  fi
}
trap finish EXIT

printf '%s\n' "${remote_url}" >"${out}/remote-url.txt"
printf '%s\n' "${remote_ref}" >"${out}/remote-ref.txt"
git ls-remote --exit-code "${remote_url}" "refs/heads/${remote_ref}" >"${out}/remote-head.txt"
expected_commit="$(awk 'NR==1{print $1}' "${out}/remote-head.txt")"
[ -n "${expected_commit}" ] || die "remote ref did not resolve"

git clone --quiet --branch "${remote_ref}" --single-branch "${remote_url}" "${clone_dir}"
actual_commit="$(git -C "${clone_dir}" rev-parse HEAD)"
[ "${actual_commit}" = "${expected_commit}" ] || die "clone moved during evaluation; retry for a stable remote head"
printf '%s\n' "${actual_commit}" >"${out}/git-commit.txt"
git -C "${clone_dir}" status --porcelain=v1 >"${out}/git-status-before.txt"
[ ! -s "${out}/git-status-before.txt" ] || die "fresh clone is unexpectedly dirty"

run_stage() {
  local name="$1"; shift
  set +e
  "$@" >"${out}/${name}.stdout.log" 2>"${out}/${name}.stderr.log"
  local rc=$?
  set -e
  printf '%s\n' "${rc}" >"${out}/${name}.exit-code.txt"
  [ "${rc}" -eq 0 ] || die "${name} failed with exit ${rc}; workspace preserved at ${workspace}"
}

run_stage bootstrap env MONGBAS_RUNTIME_DIR="${clone_runtime}" "${clone_dir}/deploy/linux/bootstrap.sh"
run_stage prepare-runtime env MONGBAS_RUNTIME_DIR="${clone_runtime}" "${clone_dir}/deploy/linux/prepare-runtime.sh"
run_stage build env MONGBAS_RUNTIME_DIR="${clone_runtime}" "${clone_dir}/deploy/linux/build.sh"

git -C "${clone_dir}" status --porcelain=v1 >"${out}/git-status-after.txt"
[ ! -s "${out}/git-status-after.txt" ] || die "build modified tracked clean-clone files"

MONGBAS_RUNTIME_DIR="${clone_runtime}" bash -c '
  set -Eeuo pipefail
  source "$1/deploy/linux/lib.sh"
  runtime_paths
  printf "fabric="; peer version 2>/dev/null | awk "/Version:/{print \$2; exit}"
  printf "go="; go version
  printf "node="; node --version
  printf "npm="; npm --version
  printf "runtimeMode="; stat -c "%a" "$MONGBAS_RUNTIME_DIR"
  printf "envMode="; stat -c "%a" "$MONGBAS_ENV_FILE"
' _ "${clone_dir}" >"${out}/tool-and-permission-manifest.txt"
docker image inspect voting-chaincode:1.0 --format '{{.Id}}' >"${out}/chaincode-image-id.txt"

node - "${out}" "${workspace}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [out, workspace] = process.argv.slice(2);
const read = name => fs.readFileSync(path.join(out, name), 'utf8').trim();
const summary = {
  schema: 'mongbas-clean-clone-build-evaluation/v1',
  scope: 'clean clone, pinned tool bootstrap, private runtime/secret preparation, dependency audit, tests, frontend and chaincode image build',
  excludes: ['fresh Fabric ledger creation', 'container startup', 'backend-to-Fabric E2E', 'systemd installation'],
  commit: read('git-commit.txt'),
  workspace,
  stageExitCodes: Object.fromEntries(['bootstrap', 'prepare-runtime', 'build'].map(name => [name, Number(read(`${name}.exit-code.txt`))])),
  cleanBefore: read('git-status-before.txt') === '',
  cleanAfter: read('git-status-after.txt') === '',
  chaincodeImageID: read('chaincode-image-id.txt'),
  gatePassed: true,
};
fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
printf '%s\n' true >"${out}/gate-passed.txt"
printf '0\n' >"${out}/exit-code.txt"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
trap - EXIT
log "clean-clone build evidence saved to ${out}; workspace preserved at ${workspace}"
