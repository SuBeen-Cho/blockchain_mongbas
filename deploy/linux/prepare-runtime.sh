#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
if [ ! -f "${MONGBAS_ENV_FILE}" ]; then
  umask 077
  install -m 0600 "${MONGBAS_REPO_DIR}/application/.env.example" "${MONGBAS_ENV_FILE}"
  credential_secret="$(openssl rand -base64 48)"
  admin_api_token="$(openssl rand -base64 48)"
  sed -i \
    -e "s|^CREDENTIAL_SECRET=.*|CREDENTIAL_SECRET=${credential_secret}|" \
    -e "s|^# *CREDENTIAL_SECRET=.*|CREDENTIAL_SECRET=${credential_secret}|" \
    -e "s|^# *ADMIN_API_TOKEN=.*|ADMIN_API_TOKEN=${admin_api_token}|" \
    "${MONGBAS_ENV_FILE}"
  sed -i 's/^ENABLE_DEMO_CREDENTIALS=.*/ENABLE_DEMO_CREDENTIALS=true/' "${MONGBAS_ENV_FILE}"
  unset credential_secret admin_api_token
  log "created secret template with generated credential/admin secrets"
else
  chmod 0600 "${MONGBAS_ENV_FILE}"
  if ! grep -q '^ADMIN_API_TOKEN=' "${MONGBAS_ENV_FILE}"; then
    admin_api_token="$(openssl rand -base64 48)"
    printf '\nADMIN_API_TOKEN=%s\n' "${admin_api_token}" >> "${MONGBAS_ENV_FILE}"
    unset admin_api_token
    log "added a generated admin API token to the existing secret env"
  fi
  if ! grep -q '^ENABLE_DEMO_CREDENTIALS=' "${MONGBAS_ENV_FILE}"; then
    printf '\nENABLE_DEMO_CREDENTIALS=true\n' >> "${MONGBAS_ENV_FILE}"
  fi
  log "preserved existing secret env"
fi

env_link="${MONGBAS_REPO_DIR}/application/.env"
if [ -e "${env_link}" ] && [ ! -L "${env_link}" ]; then
  die "${env_link} already exists and is not a symlink; preserve or move it manually"
fi
ln -sfn "${MONGBAS_ENV_FILE}" "${env_link}"
log "runtime prepared; edit ${MONGBAS_ENV_FILE} without committing it"
