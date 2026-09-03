#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/../.." && pwd)"
result_root="${MONGBAS_RESULT_DIR:-${repo_dir}/.private-results}"

for command_name in git node npm sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    printf 'ERROR: required command missing: %s\n' "${command_name}" >&2
    exit 2
  }
done
[ -x /usr/bin/time ] || { printf 'ERROR: GNU /usr/bin/time is required\n' >&2; exit 2; }

commit="$(git -C "${repo_dir}" rev-parse --verify HEAD)"
branch="$(git -C "${repo_dir}" branch --show-current)"
[ -n "${branch}" ] || { printf 'ERROR: detached HEAD is not accepted for evidence runs\n' >&2; exit 2; }
if [[ ! "${branch}" =~ ^[A-Za-z0-9._/-]{1,255}$ ]]; then
  printf 'ERROR: branch name cannot be represented safely in the evidence manifest\n' >&2
  exit 2
fi
if [ -n "$(git -C "${repo_dir}" status --porcelain=v1)" ]; then
  printf 'ERROR: frontend regression evidence requires a clean worktree\n' >&2
  exit 2
fi

install -d -m 0700 "${result_root}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
final_dir="${result_root}/frontend-regression-${run_id}"
[ ! -e "${final_dir}" ] || { printf 'ERROR: result already exists: %s\n' "${final_dir}" >&2; exit 2; }
stage_dir="$(mktemp -d "${result_root}/.frontend-regression-${run_id}.tmp.XXXXXX")"
chmod 0700 "${stage_dir}"
published=false

cleanup() {
  if [ "${published}" != true ] && [ -n "${stage_dir:-}" ] && [ -d "${stage_dir}" ]; then
    rm -rf -- "${stage_dir}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' "${commit}" >"${stage_dir}/git-commit.txt"
printf '%s\n' "${branch}" >"${stage_dir}/git-branch.txt"
git -C "${repo_dir}" status --porcelain=v1 >"${stage_dir}/git-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"${stage_dir}/started-at.txt"
uname -a >"${stage_dir}/uname.txt"
node --version >"${stage_dir}/node-version.txt"
npm --version >"${stage_dir}/npm-version.txt"
df -B1 "${repo_dir}" >"${stage_dir}/filesystem-before.txt"
free -b >"${stage_dir}/memory-before.txt" 2>&1 || true

set +e
(
  cd "${repo_dir}/frontend"
  /usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M\nuserSeconds=%U\nsystemSeconds=%S' \
    -o "${stage_dir}/test-resource-metrics.txt" npm test \
    >"${stage_dir}/test.stdout.log" 2>"${stage_dir}/test.stderr.log"
)
test_status=$?
(
  cd "${repo_dir}/frontend"
  /usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M\nuserSeconds=%U\nsystemSeconds=%S' \
    -o "${stage_dir}/build-resource-metrics.txt" npm run build \
    >"${stage_dir}/build.stdout.log" 2>"${stage_dir}/build.stderr.log"
)
build_status=$?
set -e

printf '%s\n' "${test_status}" >"${stage_dir}/test.exit-status.txt"
printf '%s\n' "${build_status}" >"${stage_dir}/build.exit-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"${stage_dir}/finished-at.txt"
df -B1 "${repo_dir}" >"${stage_dir}/filesystem-after.txt"
free -b >"${stage_dir}/memory-after.txt" 2>&1 || true
printf '{"schema":"mongbas-frontend-regression-evidence/v1","commit":"%s","branch":"%s","testExitStatus":%s,"buildExitStatus":%s}\n' \
  "${commit}" "${branch}" "${test_status}" "${build_status}" >"${stage_dir}/run-manifest.json"

(
  cd "${stage_dir}"
  find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum
) >"${stage_dir}/sha256-inventory.txt"

mv "${stage_dir}" "${final_dir}"
published=true
stage_dir=""
printf 'frontend regression evidence: %s\n' "${final_dir}"
if [ "${test_status}" -ne 0 ]; then exit "${test_status}"; fi
exit "${build_status}"
