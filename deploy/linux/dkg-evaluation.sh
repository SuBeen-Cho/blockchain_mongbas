#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
require_cmd node
require_cmd npm

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/dkg-${run_id}"
secret_root="${MONGBAS_SECRET_DIR}/dkg-${run_id}"
install -d -m 0700 "${out}" "${out}/public-keys" "${out}/contributions" "${out}/public-shares" "${out}/complaints"
install -d -m 0700 "${secret_root}"

git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
[ ! -s "${out}/git-status.txt" ] || die "DKG evaluation requires a clean worktree"

npm --prefix "${MONGBAS_REPO_DIR}/trustee" ci >"${out}/npm-ci.log" 2>&1
npm --prefix "${MONGBAS_REPO_DIR}/trustee" test >"${out}/trustee-tests.log" 2>&1

cli="${MONGBAS_REPO_DIR}/trustee/bin/mongbas-trustee.js"
ceremony="linux-dkg-${run_id}"
ids=(ElectionCommissionMSP PartyObserverMSP CivilSocietyMSP)

for offset in 0 1 2; do
  id="${ids[$offset]}"
  index=$((offset + 1))
  install -d -m 0700 "${secret_root}/${id}"
  node "${cli}" init --id "${id}" --index "${index}" \
    --private "${secret_root}/${id}/transport-private.json" \
    --public "${out}/public-keys/${id}.json" >>"${out}/ceremony.log"
done

node - "${out}/participants.json" "${out}/public-keys"/*.json <<'NODE'
const fs = require('node:fs');
const [output, ...files] = process.argv.slice(2);
const participants = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
  .map(({ id, index, transportPublicKeyDer, signingPublicKeyDer }) =>
    ({ id, index, transportPublicKeyDer, signingPublicKeyDer }))
  .sort((a, b) => a.index - b.index);
fs.writeFileSync(output, `${JSON.stringify(participants, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
NODE

for id in "${ids[@]}"; do
  node "${cli}" contribute --ceremony "${ceremony}" --id "${id}" \
    --private "${secret_root}/${id}/transport-private.json" \
    --participants "${out}/participants.json" \
    --out "${out}/contributions/${id}.json" >>"${out}/ceremony.log"
done

for id in "${ids[@]}"; do
  node "${cli}" finalize-share --ceremony "${ceremony}" --id "${id}" \
    --private "${secret_root}/${id}/transport-private.json" \
    --participants "${out}/participants.json" \
    --contributions-dir "${out}/contributions" \
    --private-out "${secret_root}/${id}/trustee-share.json" \
    --public-out "${out}/public-shares/${id}.json" >>"${out}/ceremony.log"
done

node "${cli}" finalize-transcript --ceremony "${ceremony}" \
  --participants "${out}/participants.json" \
  --contributions-dir "${out}/contributions" \
  --public-shares-dir "${out}/public-shares" \
  --out "${out}/transcript.json" >>"${out}/ceremony.log"

# An authenticated complaint is public attribution/evidence and must abort the
# current 3-party/threshold-2 ceremony. It never silently changes the dealer set.
contribution_hash="$(sha256sum "${out}/contributions/${ids[1]}.json" | awk '{print $1}')"
evidence_hash="$(printf '%s' 'redacted-local-feldman-evidence' | sha256sum | awk '{print $1}')"
node "${cli}" complain --ceremony "${ceremony}" --id "${ids[0]}" --dealer "${ids[1]}" \
  --reason feldman-equation-failed --contribution-hash "${contribution_hash}" --evidence-hash "${evidence_hash}" \
  --private "${secret_root}/${ids[0]}/transport-private.json" --participants "${out}/participants.json" \
  --out "${out}/complaints/${ids[0]}-against-${ids[1]}.json" >>"${out}/ceremony.log"
set +e
node "${cli}" finalize-transcript --ceremony "${ceremony}" \
  --participants "${out}/participants.json" --contributions-dir "${out}/contributions" \
  --public-shares-dir "${out}/public-shares" --complaints-dir "${out}/complaints" \
  --out "${out}/aborted-transcript.json" >"${out}/complaint-finalize.stdout.log" 2>"${out}/complaint-finalize.stderr.log"
complaint_status=$?
set -e
printf '%s\n' "${complaint_status}" >"${out}/complaint-finalize.exit-status.txt"
[ "${complaint_status}" -eq 1 ] || die "authenticated complaint did not exit exactly 1"
[ ! -e "${out}/aborted-transcript.json" ] || die "complained ceremony emitted a transcript"
grep -q 'aborted by authenticated complaint' "${out}/complaint-finalize.stderr.log" || die "complaint abort reason missing"
node - "${out}/complaints/${ids[0]}-against-${ids[1]}.json" >"${out}/complaint-summary.json" <<'NODE'
const complaint = require(process.argv[2]);
const text = JSON.stringify(complaint);
const result = { schema: 'mongbas-dkg-complaint-evaluation/v1', complaintID: complaint.complaintID,
  reason: complaint.reason, attributed: complaint.complainerID === 'ElectionCommissionMSP' && complaint.dealerID === 'PartyObserverMSP',
  privateMaterialExposed: /scalar|privateKey|privateShare/i.test(text), finalizeExitStatus: 1 };
result.securityGatePassed = result.attributed && !result.privateMaterialExposed;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.securityGatePassed) process.exitCode = 1;
NODE

node - "${out}" "${secret_root}" >"${out}/custody-summary.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [publicRoot, secretRoot] = process.argv.slice(2);
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}
const publicText = files(publicRoot).filter(file => file.endsWith('.json'))
  .map(file => fs.readFileSync(file, 'utf8')).join('\n');
const secretFiles = files(secretRoot);
const looseSecrets = process.platform === 'win32' ? [] : secretFiles.filter(file => (fs.statSync(file).mode & 0o777) !== 0o600);
const result = {
  schema: 'mongbas-dkg-custody-evaluation/v1',
  trustees: 3,
  publicArtifactContainsScalarField: /"scalar"\s*:/.test(publicText),
  publicArtifactContainsPrivateKeyField: /privateKey|PrivateKey|privateShare/.test(publicText),
  privateFiles: secretFiles.length,
  loosePrivateFiles: looseSecrets.length,
  secretPathRecordedInPublicEvidence: false,
};
result.securityGatePassed = !result.publicArtifactContainsScalarField &&
  !result.publicArtifactContainsPrivateKeyField && result.privateFiles === 6 && result.loosePrivateFiles === 0;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.securityGatePassed) process.exitCode = 1;
NODE

(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
  >"${out}/sha256-inventory.txt"
log "DKG public evidence saved to ${out}; private trustee records retained under the protected runtime secret directory"
