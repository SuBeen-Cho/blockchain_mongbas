#!/usr/bin/env bash
set -Eeuo pipefail

LINUX_DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONGBAS_REPO_DIR="$(cd "${LINUX_DEPLOY_DIR}/../.." && pwd)"
MONGBAS_RUNTIME_DIR="${MONGBAS_RUNTIME_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/mongbas}"
MONGBAS_PROFILE="${MONGBAS_PROFILE:-demo}"
if [ -x "${MONGBAS_RUNTIME_DIR}/tools/go-current/bin/go" ]; then
  PATH="${MONGBAS_RUNTIME_DIR}/tools/go-current/bin:${PATH}"
  export PATH
fi

log() { printf '[mongbas] %s\n' "$*"; }
die() { printf '[mongbas:error] %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command missing: $1"; }

validate_runtime_dir() {
  case "${MONGBAS_RUNTIME_DIR}" in
    ""|/|"${HOME}"|"${MONGBAS_REPO_DIR}") die "unsafe runtime directory: ${MONGBAS_RUNTIME_DIR}" ;;
  esac
}

runtime_paths() {
  validate_runtime_dir
  MONGBAS_SECRET_DIR="${MONGBAS_RUNTIME_DIR}/secrets"
  MONGBAS_LOG_DIR="${MONGBAS_RUNTIME_DIR}/logs"
  MONGBAS_RESULT_DIR="${MONGBAS_RUNTIME_DIR}/results"
  MONGBAS_ENV_FILE="${MONGBAS_ENV_FILE:-${MONGBAS_SECRET_DIR}/application.env}"
  # Preserve the name used by the already-provisioned Linux host.
  if [ ! -e "${MONGBAS_ENV_FILE}" ] && [ -f "${MONGBAS_SECRET_DIR}/backend.env" ]; then
    MONGBAS_ENV_FILE="${MONGBAS_SECRET_DIR}/backend.env"
  fi
  export MONGBAS_REPO_DIR MONGBAS_RUNTIME_DIR MONGBAS_PROFILE
  export MONGBAS_SECRET_DIR MONGBAS_LOG_DIR MONGBAS_RESULT_DIR MONGBAS_ENV_FILE
}

ensure_runtime() {
  runtime_paths
  umask 077
  install -d -m 0700 "${MONGBAS_RUNTIME_DIR}" "${MONGBAS_SECRET_DIR}" "${MONGBAS_LOG_DIR}" "${MONGBAS_RESULT_DIR}"
}

load_runtime_env() {
  runtime_paths
  [ -f "${MONGBAS_ENV_FILE}" ] || die "secret env missing: ${MONGBAS_ENV_FILE} (run prepare-runtime.sh)"
  [ "$(stat -c '%a' "${MONGBAS_ENV_FILE}")" = "600" ] || die "secret env must have mode 0600: ${MONGBAS_ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${MONGBAS_ENV_FILE}"
  set +a
  [ -n "${SESSION_SECRET:-}" ] || die "SESSION_SECRET is missing"
  [ -n "${CREDENTIAL_SECRET:-}" ] || die "CREDENTIAL_SECRET is missing"
  [ -n "${ADMIN_API_TOKEN:-}" ] || die "ADMIN_API_TOKEN is missing"
  [ "$(printf '%s' "${SESSION_SECRET}" | wc -c)" -ge 32 ] || die "SESSION_SECRET must be at least 32 bytes"
  [ "$(printf '%s' "${CREDENTIAL_SECRET}" | wc -c)" -ge 32 ] || die "CREDENTIAL_SECRET must be at least 32 bytes"
  [ "$(printf '%s' "${ADMIN_API_TOKEN}" | wc -c)" -ge 32 ] || die "ADMIN_API_TOKEN must be at least 32 bytes"
}

timestamp_utc() { date -u +'%Y%m%dT%H%M%SZ'; }
