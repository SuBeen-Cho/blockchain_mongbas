#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/../.." && pwd)"
result_root="${MONGBAS_RESULT_DIR:-${repo_dir}/.private-results}"

for command_name in git go node npm sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 || { printf 'ERROR: missing %s\n' "${command_name}" >&2; exit 2; }
done
[ -x /usr/bin/time ] || { printf 'ERROR: GNU time is required\n' >&2; exit 2; }

commit="$(git -C "${repo_dir}" rev-parse --verify HEAD)"
branch="$(git -C "${repo_dir}" branch --show-current)"
[ -n "${branch}" ] || { printf 'ERROR: detached HEAD\n' >&2; exit 2; }
[ -z "$(git -C "${repo_dir}" status --porcelain=v1)" ] || { printf 'ERROR: clean worktree required\n' >&2; exit 2; }

install -d -m 0700 "${result_root}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
final_dir="${result_root}/cast-history-producer-${run_id}"
stage_dir="$(mktemp -d "${result_root}/.cast-history-producer-${run_id}.tmp.XXXXXX")"
chmod 0700 "${stage_dir}"
published=false
cleanup() { if [ "${published}" != true ] && [ -d "${stage_dir:-}" ]; then rm -rf -- "${stage_dir}"; fi; }
trap cleanup EXIT

printf '%s\n' "${commit}" >"${stage_dir}/git-commit.txt"
printf '%s\n' "${branch}" >"${stage_dir}/git-branch.txt"
git -C "${repo_dir}" status --porcelain=v1 >"${stage_dir}/git-status.txt"
date -u +%Y-%m-%dT%H:%M:%SZ >"${stage_dir}/started-at.txt"
uname -a >"${stage_dir}/uname.txt"
go version >"${stage_dir}/go-version.txt"
node --version >"${stage_dir}/node-version.txt"
npm --version >"${stage_dir}/npm-version.txt"
df -B1 "${repo_dir}" >"${stage_dir}/filesystem-before.txt"

run_suite() {
  local name="$1" directory="$2"
  shift 2
  set +e
  (cd "${directory}" && /usr/bin/time -f 'elapsedSeconds=%e\nmaxRssKiB=%M\nuserSeconds=%U\nsystemSeconds=%S' \
    -o "${stage_dir}/${name}.metrics.txt" "$@" >"${stage_dir}/${name}.stdout.log" 2>"${stage_dir}/${name}.stderr.log")
  local status=$?
  set -e
  printf '%s\n' "${status}" >"${stage_dir}/${name}.exit-status.txt"
  return "${status}"
}

overall=0
run_suite chaincode "${repo_dir}/chaincode/voting" go test -count=1 ./... || overall=1
run_suite application "${repo_dir}/application" npm test || overall=1
run_suite verifier-focused "${repo_dir}/verifier" node --test test/cast-event-history.test.js test/cast-event-history-cli.test.js || overall=1

date -u +%Y-%m-%dT%H:%M:%SZ >"${stage_dir}/finished-at.txt"
df -B1 "${repo_dir}" >"${stage_dir}/filesystem-after.txt"
printf '{"schema":"mongbas-cast-history-producer-evidence/v1","commit":"%s","branch":"%s","exitStatus":%s}\n' \
  "${commit}" "${branch}" "${overall}" >"${stage_dir}/run-manifest.json"
(cd "${stage_dir}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
  >"${stage_dir}/sha256-inventory.txt"
mv "${stage_dir}" "${final_dir}"
published=true
stage_dir=""
printf 'cast history producer evidence: %s\n' "${final_dir}"
exit "${overall}"
