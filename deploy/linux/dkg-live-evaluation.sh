#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd docker
require_cmd node
require_cmd python3

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/dkg-live-${run_id}"
install -d -m 0700 "${out}"

dkg_public="${MONGBAS_DKG_PUBLIC_DIR:-$(ls -1dt "${MONGBAS_RESULT_DIR}"/dkg-2* 2>/dev/null | head -1)}"
dkg_secret="${MONGBAS_DKG_SECRET_DIR:-${MONGBAS_SECRET_DIR}/$(basename "${dkg_public}")}"
[ -f "${dkg_public}/transcript.json" ] || die "DKG transcript missing: ${dkg_public}/transcript.json"
[ -d "${dkg_secret}" ] || die "DKG secret directory missing: ${dkg_secret}"

git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
[ ! -s "${out}/git-status.txt" ] || die "DKG live evaluation requires a clean worktree"
cp "${dkg_public}/transcript.json" "${out}/transcript.json"

curl -fsS --max-time 10 http://127.0.0.1:3000/health >"${out}/backend-health.json"

count_shared_pdc() {
  local destination="$1" container
  : >"${destination}"
  for container in couchdb-ec0 couchdb-party couchdb-civil; do
    docker exec "${container}" sh -c \
      'curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://127.0.0.1:5984/voting-channel_voting%24%24p%24vote%24private%24collection/_all_docs?include_docs=false"' \
      | python3 -c '
import collections, json, re, sys
container = sys.argv[1]
payload = json.load(sys.stdin)
ids = [row["id"] for row in payload.get("rows", []) if "ELGAMAL_THRESHOLD_SHARE" in row.get("id", "")]
indexes = collections.Counter()
for identifier in ids:
    match = re.search(r"_(\d+)$", identifier)
    if match:
        indexes[match.group(1)] += 1
print(json.dumps({"container": container, "shareDocuments": len(ids),
                  "byIndex": {key: indexes[key] for key in sorted(indexes)}}, separators=(",", ":")))
' "${container}" >>"${destination}"
  done
}

count_shared_pdc "${out}/pdc-before.jsonl"
set +e
MONGBAS_DKG_TRANSCRIPT="${dkg_public}/transcript.json" \
MONGBAS_DKG_SECRET_ROOT="${dkg_secret}" \
MONGBAS_DKG_BASE_URL="http://127.0.0.1:3000" \
node "${MONGBAS_REPO_DIR}/application/scripts/dkg-election-e2e.js" \
  >"${out}/evaluation.json" 2>"${out}/evaluation.stderr.log"
status=$?
set -e
printf '%s\n' "${status}" >"${out}/evaluation.exit-status.txt"
count_shared_pdc "${out}/pdc-after.jsonl"

set +e
node - "${out}" >"${out}/summary.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const status = Number(fs.readFileSync(path.join(root, 'evaluation.exit-status.txt'), 'utf8').trim());
let result = {};
try { result = JSON.parse(fs.readFileSync(path.join(root, 'evaluation.json'), 'utf8')); } catch {}
const before = fs.readFileSync(path.join(root, 'pdc-before.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const after = fs.readFileSync(path.join(root, 'pdc-after.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const sharedPDCUnchanged = JSON.stringify(before) === JSON.stringify(after);
const summary = {
  schema: 'mongbas-dkg-live-evaluation/v1',
  evaluationExitStatus: status,
  exactTally: result.success === true && result.totalVotes === 3 && Object.values(result.results || {}).every(value => value === 1),
  approvals: result.approvals,
  rejectedAttackGates: Array.isArray(result.rejected) ? result.rejected : [],
  externalPartialDecryptions: result.externalPartialDecryptions,
  sharedPDCShareDocumentCountsUnchanged: sharedPDCUnchanged,
  privateScalarRecordedInEvidence: false,
};
summary.securityGatePassed = status === 0 && summary.exactTally && summary.approvals === 3 &&
  summary.externalPartialDecryptions === 2 && sharedPDCUnchanged && summary.rejectedAttackGates.length === 5;
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.securityGatePassed) process.exitCode = 1;
NODE
summary_status=$?
set -e

(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
  >"${out}/sha256-inventory.txt"
[ "${status}" -eq 0 ] && [ "${summary_status}" -eq 0 ] || die "DKG live evaluation failed; evidence saved to ${out}"
log "DKG live evidence saved to ${out}"
