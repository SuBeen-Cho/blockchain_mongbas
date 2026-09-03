#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: witness-anchor-preflight.sh <witness.db> <origin> <log-trust.json> <witness-policy.json> <external-anchor.json>" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "${script_dir}/../.." && pwd)"
db_path="$1"
origin="$2"
log_trust="$3"
witness_policy="$4"
external_anchor="$5"

for required_command in node python3; do
  command -v "${required_command}" >/dev/null 2>&1 || { echo "required command missing: ${required_command}" >&2; exit 1; }
done
case "${db_path}" in /*) ;; *) echo "witness database path must be absolute" >&2; exit 1 ;; esac
case "${external_anchor}" in /*) ;; *) echo "external anchor path must be absolute" >&2; exit 1 ;; esac
if [ -L "${db_path}" ] || [ ! -f "${db_path}" ]; then
  echo "witness database must be a regular non-symlink file" >&2
  exit 1
fi
if [ -L "${external_anchor}" ] || [ ! -f "${external_anchor}" ]; then
  echo "external anchor must be a regular non-symlink file" >&2
  exit 1
fi
if [ -z "${origin}" ] || [ "${#origin}" -gt 2048 ] || [[ "${origin}" == *$'\n'* ]]; then
  echo "witness origin is invalid" >&2
  exit 1
fi

temporary_directory="$(mktemp -d /tmp/mongbas-witness-preflight.XXXXXX)"
chmod 700 "${temporary_directory}"
checkpoint_note="${temporary_directory}/checkpoint.note"
cleanup() {
  if [[ "${temporary_directory}" == /tmp/mongbas-witness-preflight.* ]] && [ -d "${temporary_directory}" ]; then
    rm -rf -- "${temporary_directory}"
  fi
}
trap cleanup EXIT

python3 - "${db_path}" "${origin}" "${checkpoint_note}" <<'PY'
import os
import sqlite3
import sys

database, origin, output = sys.argv[1:]
connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
try:
    integrity = connection.execute("PRAGMA integrity_check").fetchall()
    if integrity != [("ok",)]:
        raise SystemExit("witness database integrity check failed")
    rows = connection.execute(
        "SELECT c.chkpt FROM chkpts AS c JOIN logs AS l ON c.logID = l.logID WHERE l.origin = ?",
        (origin,),
    ).fetchall()
    if len(rows) != 1 or not isinstance(rows[0][0], bytes) or not rows[0][0]:
        raise SystemExit("witness database must contain exactly one checkpoint for the configured origin")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, rows[0][0])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
finally:
    connection.close()
PY

node "${repo_dir}/verifier/bin/mongbas-c2sp.js" check-anchor \
  "${checkpoint_note}" "${log_trust}" "${witness_policy}" "${external_anchor}"
echo "WITNESS STARTUP PREFLIGHT PASSED: database checkpoint exactly matches external anchor"
