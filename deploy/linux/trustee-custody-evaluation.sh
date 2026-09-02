#!/usr/bin/env bash
set -Eeuo pipefail

[ "${EUID}" -eq 0 ] || { echo "run with sudo: $0" >&2; exit 1; }
umask 0027
repo="$(cd "$(dirname "$0")/../.." && pwd)"
operator="${SUDO_USER:-user1}"
operator_group="$(id -gn "${operator}")"
runtime="${MONGBAS_RUNTIME_DIR:-/home/${operator}/mongbas-runtime}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
out="${runtime}/results/trustee-custody-${run_id}"
custody_root="/var/lib/mongbas-trustees"
run_root="${custody_root}/runs/${run_id}"
public="${run_root}/public"
cli="/opt/mongbas-trustee/current/bin/mongbas-trustee.js"
users=(mongbas-ec mongbas-party mongbas-civil)
ids=(ElectionCommissionMSP PartyObserverMSP CivilSocietyMSP)
ceremony="os-custody-${run_id}"

"${repo}/deploy/linux/trustee-custody-bootstrap.sh"
install -d -o root -g "${operator_group}" -m 0750 "${out}"
install -d -o root -g mongbas-trustees -m 2750 "${run_root}"
install -d -o root -g mongbas-trustees -m 2770 "${public}" "${public}/keys" "${public}/contributions" "${public}/shares"

for offset in 0 1 2; do
  user="${users[$offset]}"; id="${ids[$offset]}"; index=$((offset + 1))
  private="${custody_root}/${user}/${run_id}"
  install -d -o "${user}" -g mongbas-trustees -m 0700 "${private}"
  runuser -u "${user}" -- node "${cli}" init --id "${id}" --index "${index}" \
    --private "${private}/transport-private.json" --public "${public}/keys/${id}.json" >>"${out}/ceremony.log"
  chmod 0640 "${public}/keys/${id}.json"
done

node - "${public}/participants.json" "${public}/keys"/*.json <<'NODE'
const fs = require('node:fs');
const [output, ...files] = process.argv.slice(2);
const participants = files.map(file => JSON.parse(fs.readFileSync(file)))
  .map(({ id, index, transportPublicKeyDer, signingPublicKeyDer }) => ({ id, index, transportPublicKeyDer, signingPublicKeyDer }))
  .sort((a, b) => a.index - b.index);
fs.writeFileSync(output, `${JSON.stringify(participants, null, 2)}\n`, { flag: 'wx', mode: 0o640 });
NODE
chown root:mongbas-trustees "${public}/participants.json"
chmod 0640 "${public}/participants.json"

for offset in 0 1 2; do
  user="${users[$offset]}"; id="${ids[$offset]}"; private="${custody_root}/${user}/${run_id}"
  runuser -u "${user}" -- node "${cli}" contribute --ceremony "${ceremony}" --id "${id}" \
    --private "${private}/transport-private.json" --participants "${public}/participants.json" \
    --out "${public}/contributions/${id}.json" >>"${out}/ceremony.log"
  chmod 0640 "${public}/contributions/${id}.json"
done

for offset in 0 1 2; do
  user="${users[$offset]}"; id="${ids[$offset]}"; private="${custody_root}/${user}/${run_id}"
  runuser -u "${user}" -- node "${cli}" finalize-share --ceremony "${ceremony}" --id "${id}" \
    --private "${private}/transport-private.json" --participants "${public}/participants.json" \
    --contributions-dir "${public}/contributions" --private-out "${private}/trustee-share.json" \
    --public-out "${public}/shares/${id}.json" >>"${out}/ceremony.log"
  chmod 0640 "${public}/shares/${id}.json"
done

node "${cli}" finalize-transcript --ceremony "${ceremony}" --participants "${public}/participants.json" \
  --contributions-dir "${public}/contributions" --public-shares-dir "${public}/shares" \
  --out "${public}/transcript.json" >>"${out}/ceremony.log"

cp -a "${public}" "${out}/public"
git -C "${repo}" rev-parse HEAD >"${out}/git-commit.txt"
git -C "${repo}" status --porcelain=v1 >"${out}/git-status.txt"
[ ! -s "${out}/git-status.txt" ] || { echo "dirty worktree" >&2; exit 1; }

readable=0
printf 'user\towner\tmode\toperatorReadable\n' >"${out}/custody.tsv"
for user in "${users[@]}"; do
  share="${custody_root}/${user}/${run_id}/trustee-share.json"
  is_readable=no
  if runuser -u "${operator}" -- test -r "${share}"; then is_readable=yes; readable=$((readable + 1)); fi
  printf '%s\t%s\t%s\t%s\n' "${user}" "$(stat -c %U "${share}")" "$(stat -c %a "${share}")" "${is_readable}" >>"${out}/custody.tsv"
done
node - "${out}/custody.tsv" >"${out}/summary.json" <<'NODE'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').slice(1).map(line => line.split('\t'));
const result = { schema: 'mongbas-os-trustee-custody/v1', distinctOwners: new Set(rows.map(row => row[1])).size,
  sharesMode0600: rows.every(row => row[2] === '600'), operatorReadableShares: rows.filter(row => row[3] === 'yes').length,
  physicalHostIndependent: false, rootAdministratorTrusted: true };
result.securityGatePassed = result.distinctOwners === 3 && result.sharesMode0600 && result.operatorReadableShares === 0;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.securityGatePassed) process.exitCode = 1;
NODE

chown -R "${operator}:${operator_group}" "${out}"
(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) >"${out}/sha256-inventory.txt"
chown "${operator}:${operator_group}" "${out}/sha256-inventory.txt"
printf 'trustee custody evidence: %s\n' "${out}"
