#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

[ "$(uname -s)" = Linux ] || die "bootstrap supports Linux only"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "validated distribution is Ubuntu, found ${ID:-unknown}"
  [ "${VERSION_ID:-}" = "24.04" ] || log "warning: validated on Ubuntu 24.04, found ${VERSION_ID:-unknown}"
fi

missing=()
for cmd in curl git jq openssl rsync; do command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd"); done
if [ "${#missing[@]}" -gt 0 ]; then
  log "installing missing base packages: ${missing[*]}"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git jq openssl rsync
fi

require_cmd docker
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
docker info >/dev/null 2>&1 || die "Docker daemon is unavailable or this user lacks permission"
require_cmd node
require_cmd npm
require_cmd go
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<12)) process.exit(1)' \
  || die "Node.js 22.12 or newer is required"

ensure_runtime
log "bootstrap checks passed; runtime=${MONGBAS_RUNTIME_DIR}"
