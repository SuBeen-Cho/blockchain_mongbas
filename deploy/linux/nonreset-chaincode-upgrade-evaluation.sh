#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd curl
require_cmd docker
require_cmd git
require_cmd python3
require_cmd sha256sum
[ -x /usr/bin/time ] || die "GNU /usr/bin/time is required"

[ "${MONGBAS_APPROVE_NONRESET_CHAINCODE_UPGRADE:-}" = APPROVE_NONRESET_CHAINCODE_UPGRADE ] \
  || die "set MONGBAS_APPROVE_NONRESET_CHAINCODE_UPGRADE=APPROVE_NONRESET_CHAINCODE_UPGRADE"

fabric_network_dir="${MONGBAS_FABRIC_NETWORK_DIR:-}"
case "${fabric_network_dir}" in /*) ;; *) die "MONGBAS_FABRIC_NETWORK_DIR must be an absolute protected network path" ;; esac
[ -f "${fabric_network_dir}/docker-compose.yaml" ] || die "protected Fabric network compose file is missing"
[ -d "${fabric_network_dir}/crypto-config" ] || die "protected Fabric identities are missing"
[ -d "${fabric_network_dir}/channel-artifacts" ] || die "protected Fabric channel artifacts are missing"

commit="$(git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD)"
run_id="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/nonreset-chaincode-upgrade-${run_id}"
install -d -m 0700 "${out}"
printf '%s\n' "${commit}" >"${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
[ ! -s "${out}/git-status.txt" ] || die "upgrade evaluation requires a clean worktree"

capture_definition() {
  local destination="$1"
  docker exec cli peer lifecycle chaincode querycommitted \
    --channelID voting-channel --name voting --output json >"${destination}"
}
capture_channel() {
  docker exec cli peer channel getinfo -c voting-channel >"$1" 2>&1
}
capture_runtime() {
  local suffix="$1"
  docker ps --no-trunc --format '{{json .}}' >"${out}/containers-${suffix}.jsonl" 2>&1 || true
  docker image ls --no-trunc --digests --format '{{json .}}' >"${out}/images-${suffix}.jsonl" 2>&1 || true
  docker volume ls --format '{{.Name}}' | LC_ALL=C sort >"${out}/volumes-${suffix}.txt" 2>&1 || true
}

before_captured=false
completed=false
finalize() {
  local status=$?
  trap - EXIT
  set +e
  if [ "${before_captured}" = true ]; then
    capture_definition "${out}/chaincode-after.json"
    capture_channel "${out}/channel-after.txt"
    capture_runtime after
  fi
  curl --silent --show-error --fail --max-time 5 http://127.0.0.1:3000/health \
    >"${out}/normal-backend-final-health.json" 2>"${out}/normal-backend-final-health.stderr.log"
  printf '%s\n' "${status}" >"${out}/wrapper.exit-status.txt"
  printf '%s\n' "${completed}" >"${out}/completed.txt"
  (cd "${out}" && find . -type f ! -name sha256-inventory.txt -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    >"${out}/sha256-inventory.txt"
  exit "${status}"
}
trap finalize EXIT

"${LINUX_DEPLOY_DIR}/collect-environment.sh" "${out}/environment"
capture_definition "${out}/chaincode-before.json"
capture_channel "${out}/channel-before.txt"
capture_runtime before
before_captured=true

before_seq="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "${out}/chaincode-before.json")"
[[ "${before_seq}" =~ ^[0-9]+$ ]] && [ "${before_seq}" -gt 0 ] \
  || die "non-reset upgrade requires an existing committed definition"
next_seq=$((before_seq + 1))
old_image="$(docker image inspect voting-chaincode:1.0 --format '{{.Id}}')"
[[ "${old_image}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "current chaincode image is not content-addressed"
printf '%s\n' "${old_image}" >"${out}/old-image-id.txt"
printf '%s\n' "${before_seq}" >"${out}/before-sequence.txt"
printf '%s\n' "${next_seq}" >"${out}/requested-sequence.txt"

set +e
/usr/bin/time -v env \
  MONGBAS_RUNTIME_DIR="${MONGBAS_RUNTIME_DIR}" \
  FABRIC_NETWORK_DIR="${fabric_network_dir}" \
  MONGBAS_CHAINCODE_SOURCE_DIR="${MONGBAS_REPO_DIR}/chaincode/voting" \
  "${MONGBAS_REPO_DIR}/network/scripts/network.sh" deploy \
  >"${out}/deploy.stdout.log" 2>"${out}/deploy.stderr.log"
deploy_status=$?
set -e
printf '%s\n' "${deploy_status}" >"${out}/deploy.exit-status.txt"
[ "${deploy_status}" -eq 0 ] || die "non-reset chaincode deploy failed; preserved evidence: ${out}"

capture_definition "${out}/chaincode-after.json"
capture_channel "${out}/channel-after.txt"
capture_runtime after

after_seq="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sequence"])' "${out}/chaincode-after.json")"
if (( after_seq != before_seq + 1 )); then die "committed sequence did not advance exactly once"; fi
if ! cmp -s "${out}/volumes-before.txt" "${out}/volumes-after.txt"; then
  before_volumes="$(sha256sum "${out}/volumes-before.txt" | cut -d' ' -f1)"
  after_volumes="$(sha256sum "${out}/volumes-after.txt" | cut -d' ' -f1)"
  if [[ "${before_volumes}" != "${after_volumes}" ]]; then die "Fabric volume inventory changed during non-reset upgrade"; fi
fi

rollback_image="$(docker image inspect "voting-chaincode:rollback-seq-${before_seq}" --format '{{.Id}}')"
candidate_image="$(docker image inspect "voting-chaincode:candidate-seq-${after_seq}" --format '{{.Id}}')"
current_image="$(docker image inspect voting-chaincode:1.0 --format '{{.Id}}')"
candidate_running="$(docker inspect -f '{{.State.Running}}' "voting-chaincode-seq-${after_seq}" 2>/dev/null || true)"
printf '%s\n' "${rollback_image}" >"${out}/rollback-image-id.txt"
printf '%s\n' "${candidate_image}" >"${out}/candidate-image-id.txt"
printf '%s\n' "${current_image}" >"${out}/current-image-id.txt"
printf '%s\n' "${candidate_running}" >"${out}/candidate-running.txt"
if [[ "${rollback_image}" != "${old_image}" ]]; then die "rollback image does not preserve the old executable"; fi
if [[ "${current_image}" != "${candidate_image}" ]]; then die "current image was not advanced to the committed candidate"; fi
if [[ "${candidate_running}" != "true" ]]; then die "committed candidate container is not running"; fi

python3 - "${out}/chaincode-before.json" "${out}/chaincode-after.json" <<'PY'
import json, sys
before, after = (json.load(open(path)) for path in sys.argv[1:])
assert after["sequence"] == before["sequence"] + 1
assert after["version"] == before["version"]
PY

curl --silent --show-error --fail --max-time 5 http://127.0.0.1:3000/health \
  >"${out}/normal-backend-final-health.json"
completed=true
log "non-reset chaincode upgrade evidence saved to ${out}"
