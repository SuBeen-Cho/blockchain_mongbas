#!/usr/bin/env bash
set -Eeuo pipefail

[ "${EUID}" -eq 0 ] || { echo "partial helper requires root" >&2; exit 1; }
[ "$#" -eq 5 ] || { echo "usage: helper MSP_ID INDEX ELECTION AGGREGATE OUTPUT" >&2; exit 2; }
msp="$1"; index="$2"; election="$3"; aggregate="$4"; output="$5"
run_id="${MONGBAS_OS_CUSTODY_RUN_ID:-}"
[[ "${run_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "invalid custody run ID" >&2; exit 1; }
[[ "${election}" =~ ^[A-Za-z0-9._-]{1,256}$ ]] || { echo "invalid election ID" >&2; exit 1; }
[[ "${aggregate}" =~ ^/tmp/mongbas-dkg-aggregate-[0-9a-f]{32}\.json$ ]] || { echo "invalid aggregate path" >&2; exit 1; }
[[ "${output}" =~ ^/tmp/mongbas-dkg-partial-[0-9a-f]{32}\.json$ ]] || { echo "invalid output path" >&2; exit 1; }
[ -f "${aggregate}" ] && [ ! -L "${aggregate}" ] && [ "$(stat -c %U "${aggregate}")" = root ] || { echo "unsafe aggregate input" >&2; exit 1; }
[ ! -e "${output}" ] && [ ! -L "${output}" ] || { echo "partial output already exists" >&2; exit 1; }

case "${msp}:${index}" in
  ElectionCommissionMSP:1) user=mongbas-ec ;;
  PartyObserverMSP:2) user=mongbas-party ;;
  CivilSocietyMSP:3) user=mongbas-civil ;;
  *) echo "MSP/index binding rejected" >&2; exit 1 ;;
esac
share="/var/lib/mongbas-trustees/${user}/${run_id}/trustee-share.json"
[ -f "${share}" ] && [ ! -L "${share}" ] && [ "$(stat -c %U:%a "${share}")" = "${user}:600" ] || {
  echo "protected trustee share missing or misowned" >&2; exit 1;
}
runuser -u "${user}" -- node /opt/mongbas-trustee/current/bin/mongbas-trustee.js partial \
  --election "${election}" --private-share "${share}" --aggregate "${aggregate}" --out "${output}"
chmod 0644 "${output}"
