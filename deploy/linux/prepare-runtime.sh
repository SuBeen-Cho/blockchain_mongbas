#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
if [ ! -f "${MONGBAS_ENV_FILE}" ]; then
  umask 077
  install -m 0600 "${MONGBAS_REPO_DIR}/application/.env.example" "${MONGBAS_ENV_FILE}"
  session_secret="$(openssl rand -base64 48)"
  credential_secret="$(openssl rand -base64 48)"
  sed -i \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${session_secret}|" \
    -e "s|^# *SESSION_SECRET=.*|SESSION_SECRET=${session_secret}|" \
    -e "s|^CREDENTIAL_SECRET=.*|CREDENTIAL_SECRET=${credential_secret}|" \
    -e "s|^# *CREDENTIAL_SECRET=.*|CREDENTIAL_SECRET=${credential_secret}|" \
    "${MONGBAS_ENV_FILE}"
  unset session_secret credential_secret
  log "created secret template with generated session/credential secrets"
else
  chmod 0600 "${MONGBAS_ENV_FILE}"
  log "preserved existing secret env"
fi

env_link="${MONGBAS_REPO_DIR}/application/.env"
if [ -e "${env_link}" ] && [ ! -L "${env_link}" ]; then
  die "${env_link} already exists and is not a symlink; preserve or move it manually"
fi
ln -sfn "${MONGBAS_ENV_FILE}" "${env_link}"
log "runtime prepared; edit ${MONGBAS_ENV_FILE} without committing it"
