#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

ensure_runtime
load_runtime_env
require_cmd npm
require_cmd systemd-analyze

action="${1:---render-only}"
case "${action}" in
  --render-only|--install|--enable-now) ;;
  *) die "usage: $0 [--render-only|--install|--enable-now]" ;;
esac

service_user="${MONGBAS_SERVICE_USER:-$(id -un)}"
service_group="${MONGBAS_SERVICE_GROUP:-$(id -gn)}"
application_dir="${MONGBAS_REPO_DIR}/application"
wallet_dir="${application_dir}/wallet"
npm_path="$(command -v npm)"
template="${LINUX_DEPLOY_DIR}/systemd/mongbas-backend.service.in"
render_dir="${MONGBAS_RUNTIME_DIR}/systemd"
rendered="${render_dir}/mongbas-backend.service"

[ -f "${template}" ] || die "systemd template missing: ${template}"
[ -d "${application_dir}" ] || die "application directory missing: ${application_dir}"
[ -x "${npm_path}" ] || die "npm is not executable: ${npm_path}"
[ "$(stat -c '%a' "${MONGBAS_ENV_FILE}")" = 600 ] || die "secret env must have mode 0600"
install -d -m 0700 "${render_dir}" "${wallet_dir}"

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
sed \
  -e "s|@SERVICE_USER@|$(escape_sed "${service_user}")|g" \
  -e "s|@SERVICE_GROUP@|$(escape_sed "${service_group}")|g" \
  -e "s|@APPLICATION_DIR@|$(escape_sed "${application_dir}")|g" \
  -e "s|@ENV_FILE@|$(escape_sed "${MONGBAS_ENV_FILE}")|g" \
  -e "s|@NPM_PATH@|$(escape_sed "${npm_path}")|g" \
  -e "s|@RUNTIME_DIR@|$(escape_sed "${MONGBAS_RUNTIME_DIR}")|g" \
  -e "s|@WALLET_DIR@|$(escape_sed "${wallet_dir}")|g" \
  "${template}" >"${rendered}"
chmod 0600 "${rendered}"

if grep -Eq '@[A-Z_]+@' "${rendered}"; then
  die "unresolved placeholder in rendered unit"
fi
systemd-analyze verify "${rendered}"
log "verified rendered unit: ${rendered}"

if [ "${action}" = "--render-only" ]; then
  exit 0
fi

require_cmd sudo
sudo install -o root -g root -m 0644 "${rendered}" /etc/systemd/system/mongbas-backend.service
sudo systemctl daemon-reload
log "installed /etc/systemd/system/mongbas-backend.service"

if [ "${action}" = "--enable-now" ]; then
  sudo systemctl enable --now mongbas-backend.service
  sudo systemctl --no-pager --full status mongbas-backend.service
fi
