#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -lt 6 ]; then
  echo "usage: witness-anchored-start.sh <witness.db> <origin> <log-trust.json> <witness-policy.json> <external-anchor.json> <absolute-witness-command> [args...]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
db_path="$1"
origin="$2"
log_trust="$3"
witness_policy="$4"
external_anchor="$5"
shift 5
command_path="$1"

case "${command_path}" in
  /*) ;;
  *) echo "witness command path must be absolute" >&2; exit 2 ;;
esac
if [ ! -f "${command_path}" ] || [ ! -x "${command_path}" ]; then
  echo "witness command must be an executable regular file" >&2
  exit 2
fi

"${script_dir}/witness-anchor-preflight.sh" \
  "${db_path}" "${origin}" "${log_trust}" "${witness_policy}" "${external_anchor}"

echo "WITNESS STARTUP GATE PASSED: executing pinned witness process"
exec "$@"
