#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
require_cmd docker
require_cmd python3

run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/pdc-custody-${run_id}"
install -d -m 0700 "${out}"

git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
[ ! -s "${out}/git-status.txt" ] || die "PDC custody evaluation requires a clean worktree"

# Query document IDs only. Private values, CouchDB credentials and election IDs
# are neither written to evidence nor printed. Authentication is expanded only
# inside each CouchDB container from its existing environment.
db_path='voting-channel_voting%24%24p%24vote%24private%24collection'
: >"${out}/counts.jsonl"
for container in couchdb-ec0 couchdb-party couchdb-civil; do
  docker inspect "${container}" --format '{{.State.Status}}' | grep -qx running \
    || die "required CouchDB is not running: ${container}"
  docker exec "${container}" sh -c \
    'curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://127.0.0.1:5984/'"${db_path}"'/_all_docs?include_docs=false"' \
    | python3 -c '
import collections, json, re, sys
container = sys.argv[1]
payload = json.load(sys.stdin)
ids = [row["id"] for row in payload.get("rows", [])
       if "ELGAMAL_THRESHOLD_SHARE" in row.get("id", "")]
by_index = collections.Counter()
for identifier in ids:
    match = re.search(r"_(\d+)$", identifier)
    if match:
        by_index[match.group(1)] += 1
print(json.dumps({
    "container": container,
    "thresholdShareDocumentCount": len(ids),
    "byShareIndex": {key: by_index[key] for key in sorted(by_index)},
}, separators=(",", ":")))
' "${container}" >>"${out}/counts.jsonl"
done

python3 - "${out}/counts.jsonl" >"${out}/summary.json" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as stream:
    observations = [json.loads(line) for line in stream if line.strip()]

expected_indexes = {"1", "2", "3"}
all_share_indexes_visible = all(
    expected_indexes.issubset(set(item["byShareIndex"]))
    and all(item["byShareIndex"].get(index, 0) > 0 for index in expected_indexes)
    for item in observations
)
summary = {
    "schema": "mongbas-pdc-custody-evaluation/v1",
    "observation": "document identifiers only; private values were not read",
    "containersObserved": len(observations),
    "allThreeShareIndexesVisibleToEveryOrganizationDatabase": all_share_indexes_visible,
    "securityGatePassed": not all_share_indexes_visible,
    "interpretation": (
        "FAIL: a single organization database contains all trustee-share indexes"
        if all_share_indexes_visible else
        "PASS: no observed organization database contains every trustee-share index"
    ),
}
print(json.dumps(summary, indent=2, sort_keys=True))
PY

(cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | sort -z | xargs -0 sha256sum) \
  >"${out}/sha256-inventory.txt"

if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["securityGatePassed"] else 1)' "${out}/summary.json"; then
  log "PDC custody isolation gate passed; evidence saved to ${out}"
  exit 0
fi

log "PDC custody isolation gate FAILED as expected for the current shared collection; evidence saved to ${out}"
exit 1
