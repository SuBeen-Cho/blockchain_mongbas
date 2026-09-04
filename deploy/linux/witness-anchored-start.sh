#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -lt 7 ]; then
  echo "usage: witness-anchored-start.sh <witness.db> <origin> <log-trust.json> <witness-policy.json> <external-anchor.json> <command-sha256> <absolute-witness-command> [args...]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
db_path="$1"
origin="$2"
log_trust="$3"
witness_policy="$4"
external_anchor="$5"
shift 5
expected_command_sha256="$1"
shift
command_path="$1"
shift

command -v sha256sum >/dev/null 2>&1 || { echo "required command missing: sha256sum" >&2; exit 1; }
case "${expected_command_sha256}" in
  *[!0-9a-f]*|'') echo "witness command SHA-256 must be 64 lowercase hexadecimal characters" >&2; exit 2 ;;
esac
[ "${#expected_command_sha256}" -eq 64 ] || { echo "witness command SHA-256 must be 64 lowercase hexadecimal characters" >&2; exit 2; }

case "${command_path}" in
  /*) ;;
  *) echo "witness command path must be absolute" >&2; exit 2 ;;
esac
if [ -L "${command_path}" ] || [ ! -f "${command_path}" ] || [ ! -x "${command_path}" ]; then
  echo "witness command must be an executable regular non-symlink file" >&2
  exit 2
fi

exec 9<"${command_path}"
actual_command_sha256="$(sha256sum /dev/fd/9 | awk '{print $1}')"
[ "${actual_command_sha256}" = "${expected_command_sha256}" ] || {
  echo "witness command SHA-256 does not match the pinned executable" >&2
  exit 1
}

for sqlite_sidecar in "${db_path}-wal" "${db_path}-shm"; do
  if [ -L "${sqlite_sidecar}" ]; then
    echo "witness database sidecar must not be a symlink" >&2
    exit 1
  fi
done

state_fingerprint() {
  local state_path
  for state_path in "${db_path}" "${db_path}-wal" "${db_path}-shm"; do
    if [ -L "${state_path}" ]; then
      printf 'symlink\n'
    elif [ -f "${state_path}" ]; then
      printf 'file:'
      sha256sum "${state_path}" | awk '{print $1}'
    elif [ -e "${state_path}" ]; then
      printf 'other\n'
    else
      printf 'absent\n'
    fi
  done | sha256sum | awk '{print $1}'
}

database_before="$(state_fingerprint)"

"${script_dir}/witness-anchor-preflight.sh" \
  "${db_path}" "${origin}" "${log_trust}" "${witness_policy}" "${external_anchor}"
database_after="$(state_fingerprint)"
[ "${database_before}" = "${database_after}" ] || {
  echo "witness database changed during startup preflight" >&2
  exit 1
}

echo "WITNESS STARTUP GATE PASSED: executing pinned witness process"
if [ -e /proc/self/fd/9 ]; then
  exec /proc/self/fd/9 "$@"
fi
# Compatibility path for non-Linux regression hosts. Production Linux uses
# the already-open descriptor above so a pathname replacement is not executed.
exec "${command_path}" "$@"
