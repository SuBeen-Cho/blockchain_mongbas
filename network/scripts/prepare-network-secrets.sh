#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

network_dir="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
case "${network_dir}" in /*) ;; *) echo "network directory must be absolute" >&2; exit 1 ;; esac
[ -d "${network_dir}" ] || { echo "network directory does not exist" >&2; exit 1; }

output="${network_dir}/.env"
if [ -L "${output}" ]; then
  echo "refusing symlink network secret file" >&2
  exit 1
fi
if [ -e "${output}" ]; then
  [ -f "${output}" ] || { echo "network secret path is not a regular file" >&2; exit 1; }
  mode="$(stat -f '%Lp' "${output}" 2>/dev/null || stat -c '%a' "${output}")"
  [ "${mode}" = 600 ] || { echo "network secret file must have mode 0600" >&2; exit 1; }
  echo "network secret file already exists; preserving it" >&2
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required to generate network secrets" >&2; exit 1; }
temporary="$(mktemp "${network_dir}/.env.tmp.XXXXXX")"
cleanup() { [ ! -e "${temporary}" ] || unlink "${temporary}"; }
trap cleanup EXIT

couchdb_password="$(openssl rand -hex 32)"
ec_password="$(openssl rand -hex 32)"
party_password="$(openssl rand -hex 32)"
civil_password="$(openssl rand -hex 32)"

{
  printf 'MONGBAS_COUCHDB_USER=mongbas\n'
  printf 'MONGBAS_COUCHDB_PASSWORD=%s\n' "${couchdb_password}"
  printf 'MONGBAS_CA_EC_BOOTSTRAP_USER=ec-bootstrap\n'
  printf 'MONGBAS_CA_EC_BOOTSTRAP_PASSWORD=%s\n' "${ec_password}"
  printf 'MONGBAS_CA_PARTY_BOOTSTRAP_USER=party-bootstrap\n'
  printf 'MONGBAS_CA_PARTY_BOOTSTRAP_PASSWORD=%s\n' "${party_password}"
  printf 'MONGBAS_CA_CIVIL_BOOTSTRAP_USER=civil-bootstrap\n'
  printf 'MONGBAS_CA_CIVIL_BOOTSTRAP_PASSWORD=%s\n' "${civil_password}"
} >"${temporary}"
chmod 0600 "${temporary}"
ln "${temporary}" "${output}"
unlink "${temporary}"
trap - EXIT
echo "generated protected network secret file at ${output}" >&2
