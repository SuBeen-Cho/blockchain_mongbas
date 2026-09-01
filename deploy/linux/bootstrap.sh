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
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<12)) process.exit(1)' \
  || die "Node.js 22.12 or newer is required"

ensure_runtime
go_ok=false
if command -v go >/dev/null 2>&1; then
  go_version="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
  go_major="${go_version%%.*}"
  go_rest="${go_version#*.}"
  go_minor="${go_rest%%.*}"
  if [ "${go_major:-0}" -gt 1 ] || { [ "${go_major:-0}" -eq 1 ] && [ "${go_minor:-0}" -ge 23 ]; }; then
    go_ok=true
  fi
fi
if [ "${go_ok}" != true ]; then
  go_release="1.26.5"
  case "$(uname -m)" in
    x86_64) go_arch=amd64; go_sha256=5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053 ;;
    aarch64|arm64) go_arch=arm64; go_sha256=fe4789e92b1f33358680864bbe8704289e7bb5fc207d80623c308935bd696d49 ;;
    *) die "automatic Go install supports amd64/arm64 only" ;;
  esac
  go_tools="${MONGBAS_RUNTIME_DIR}/tools"
  go_target="${go_tools}/go${go_release}"
  install -d -m 0700 "${go_tools}"
  if [ ! -x "${go_target}/bin/go" ]; then
    archive="$(mktemp)"
    trap 'rm -f "${archive:-}"' EXIT
    log "installing verified Go ${go_release} in private runtime"
    curl --fail --location --silent --show-error "https://go.dev/dl/go${go_release}.linux-${go_arch}.tar.gz" -o "${archive}"
    printf '%s  %s\n' "${go_sha256}" "${archive}" | sha256sum --check --status || die "Go archive checksum mismatch"
    staging="${go_tools}/.go${go_release}.staging"
    rm -rf "${staging}"
    install -d -m 0700 "${staging}"
    tar -C "${staging}" -xzf "${archive}"
    mv "${staging}/go" "${go_target}"
    rmdir "${staging}"
  fi
  ln -sfn "${go_target}" "${go_tools}/go-current"
  PATH="${go_tools}/go-current/bin:${PATH}"
  export PATH
fi
go version
log "bootstrap checks passed; runtime=${MONGBAS_RUNTIME_DIR}"
