#!/usr/bin/env bash
set -Eeuo pipefail

[ "${EUID}" -eq 0 ] || { echo "run with sudo: $0" >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "${script_dir}/lib.sh"
operator="${SUDO_USER:-user1}"
operator_group="$(id -gn "${operator}")"
custody_run="${MONGBAS_OS_CUSTODY_RUN_ID:-}"
[[ "${custody_run}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "set MONGBAS_OS_CUSTODY_RUN_ID to a successful custody run"
export MONGBAS_RUNTIME_DIR="${MONGBAS_RUNTIME_DIR:-/home/${operator}/mongbas-runtime}"
ensure_runtime
load_runtime_env
public="/var/lib/mongbas-trustees/runs/${custody_run}/public"
[ -f "${public}/transcript.json" ] || die "OS-custody public transcript missing"

before="$(find "${MONGBAS_RESULT_DIR}" -maxdepth 1 -type d -name 'dkg-live-*' -printf '%f\n' | sort | tail -1)"
MONGBAS_DKG_PUBLIC_DIR="${public}" \
MONGBAS_DKG_SECRET_DIR="/not-used-with-external-helper" \
MONGBAS_DKG_PARTIAL_HELPER="${script_dir}/os-trustee-partial-helper.sh" \
MONGBAS_OS_CUSTODY_RUN_ID="${custody_run}" \
  "${script_dir}/dkg-live-evaluation.sh"
after="$(find "${MONGBAS_RESULT_DIR}" -maxdepth 1 -type d -name 'dkg-live-*' -printf '%f\n' | sort | tail -1)"
[ -n "${after}" ] && [ "${after}" != "${before}" ] || die "OS-custody live result directory was not created"
result="${MONGBAS_RESULT_DIR}/${after}"
node - "${result}/summary.json" <<'NODE'
const value = require(process.argv[2]);
if (!value.securityGatePassed || value.partialGenerationMode !== 'external-helper') {
  throw new Error('live DKG did not use the external OS-account helper');
}
NODE
chown -R "${operator}:${operator_group}" "${result}"
printf 'OS-account trustee live evidence: %s\n' "${result}"
