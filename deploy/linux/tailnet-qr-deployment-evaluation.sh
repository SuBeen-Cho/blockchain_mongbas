#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Fail-closed deployment/evidence wrapper for the approved tailnet-only QR
# profile. It never configures Funnel, resets Fabric, or changes chaincode.
approval="${1:-}"
expected_origin="${2:-}"
[ "${approval}" = "APPLY_TAILNET_QR_PROFILE_WITHOUT_RESET" ] ||
  die "explicit approval argument is required"

ensure_runtime
require_cmd curl
require_cmd docker
require_cmd git
require_cmd pgrep
require_cmd python3
require_cmd sha256sum
require_cmd ss
require_cmd sudo
require_cmd systemctl

case "${expected_origin}" in
  https://*.ts.net) ;;
  *) die "origin must be an exact https://*.ts.net origin" ;;
esac
case "${expected_origin#https://}" in
  *:*|*/*|*\?*|*\#*) die "origin must not contain port, path, query, or fragment" ;;
esac

# A deployment changes the loaded backend and must never overlap a preserved
# long-running verifier evaluation.
if pgrep -af '[v]erifier-evaluation\.sh' >/dev/null 2>&1; then
  die "verifier evaluation is active; preserve it and deploy only after it exits"
fi

[ -z "$(git -C "${MONGBAS_REPO_DIR}" status --porcelain --untracked-files=normal)" ] ||
  die "repository worktree must be clean"
branch="$(git -C "${MONGBAS_REPO_DIR}" symbolic-ref --quiet --short HEAD)"
[ "${branch}" = "feat/ballot-history-consistency" ] || die "QR deployment requires the feature branch"

stamp="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/tailnet-qr-deployment-${stamp}"
backup_dir="${MONGBAS_SECRET_DIR}/backups"
admission_dir="${MONGBAS_RUNTIME_DIR}/admission"
backup="${backup_dir}/application-before-tailnet-qr-${stamp}.env"
admission_file="${admission_dir}/demo-admissions.json"
(umask 077; mkdir "${out}")
install -d -m 0700 "${backup_dir}" "${admission_dir}"

failure_note() {
  status=$?
  printf 'status=failed\nexitCode=%s\nfinishedUtc=%s\n' "${status}" "$(date -u +'%FT%TZ')" >"${out}/result.txt"
  find "${out}" -type f ! -name sha256.txt ! -name sha256.txt.tmp -print0 | sort -z |
    xargs -0 -r sha256sum >"${out}/sha256.txt.tmp" || true
  mv "${out}/sha256.txt.tmp" "${out}/sha256.txt" 2>/dev/null || true
  exit "${status}"
}
trap failure_note ERR

git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" status --porcelain=v1 >"${out}/git-status.txt"
date -u +'%FT%TZ' >"${out}/started-utc.txt"
systemctl show mongbas-backend.service \
  -p ActiveState -p SubState -p MainPID -p FragmentPath -p UnitFileState >"${out}/service-before.txt"
systemctl cat mongbas-backend.service >"${out}/unit-before.txt"
ss -lntp >"${out}/listeners-before.txt"
sha256sum "${MONGBAS_ENV_FILE}" >"${out}/environment-before.sha256"
docker ps --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Status}}' >"${out}/docker-before.tsv"
docker volume ls --format '{{.Name}}' | sort >"${out}/volumes-before.txt"

python3 "${LINUX_DEPLOY_DIR}/configure-tailnet-qr-profile.py" \
  "${MONGBAS_ENV_FILE}" "${expected_origin}" "${backup}" "${admission_file}" \
  >"${out}/profile-configuration.log"
sha256sum "${MONGBAS_ENV_FILE}" >"${out}/environment-after.sha256"
sha256sum "${backup}" >"${out}/environment-backup.sha256"
printf '%s\n' "${backup}" >"${out}/recovery-backup-path.txt"

MONGBAS_RUNTIME_DIR="${MONGBAS_RUNTIME_DIR}" "${LINUX_DEPLOY_DIR}/install-systemd.sh" --install \
  >"${out}/systemd-install.log" 2>&1
sudo systemctl restart mongbas-backend.service
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3000/health >"${out}/health.json"; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health >/dev/null

MONGBAS_RUNTIME_DIR="${MONGBAS_RUNTIME_DIR}" "${LINUX_DEPLOY_DIR}/qr-preflight.sh" >"${out}/qr-preflight.log" 2>&1 || {
  # Serve may not yet be configured and is reported as a warning; any nonzero
  # result represents a real preflight failure.
  die "post-deployment QR preflight failed; inspect preserved evidence"
}
systemctl show mongbas-backend.service \
  -p ActiveState -p SubState -p MainPID -p FragmentPath -p UnitFileState >"${out}/service-after.txt"
ss -lntp >"${out}/listeners-after.txt"
docker ps --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Status}}' >"${out}/docker-after.tsv"
docker volume ls --format '{{.Name}}' | sort >"${out}/volumes-after.txt"
cmp "${out}/volumes-before.txt" "${out}/volumes-after.txt" >"${out}/volume-invariance.txt"
printf 'status=passed\nfinishedUtc=%s\n' "$(date -u +'%FT%TZ')" >"${out}/result.txt"
find "${out}" -type f ! -name sha256.txt -print0 | sort -z | xargs -0 sha256sum >"${out}/sha256.txt"
trap - ERR
log "tailnet QR backend deployment passed: ${out}"
log "recovery env backup is protected at: ${backup}"
