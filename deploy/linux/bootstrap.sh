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

# A public clean clone intentionally excludes Fabric binaries and generated
# config. Install the pinned official release into private runtime. Existing
# repo-local tools are preserved; network.sh prefers this verified runtime copy.
fabric_version="2.5.16"
case "$(uname -m)" in
  x86_64) fabric_arch=amd64; fabric_sha256=18c91e7f2f11b601e6622cc70454d568af897707ee9adf111e9fa91a233881bf ;;
  aarch64|arm64) fabric_arch=arm64; fabric_sha256=c3c1809afab1998e9f2dd37ccd7fc5fa97658cdeaaa9ca0de29e896bf6dee029 ;;
  *) die "automatic Fabric binary install supports amd64/arm64 only" ;;
esac
fabric_tools="${MONGBAS_RUNTIME_DIR}/tools"
fabric_target="${fabric_tools}/fabric-${fabric_version}-linux-${fabric_arch}"
install -d -m 0700 "${fabric_tools}"
if [ ! -x "${fabric_target}/bin/peer" ] || [ ! -f "${fabric_target}/config/core.yaml" ]; then
  [ ! -e "${fabric_target}" ] || die "incomplete Fabric runtime target must be preserved for inspection: ${fabric_target}"
  fabric_archive="$(mktemp)"
  trap 'rm -f "${fabric_archive:-}"' EXIT
  log "installing verified Hyperledger Fabric ${fabric_version} binaries in private runtime"
  curl --fail --location --retry 5 --silent --show-error \
    "https://github.com/hyperledger/fabric/releases/download/v${fabric_version}/hyperledger-fabric-linux-${fabric_arch}-${fabric_version}.tar.gz" \
    -o "${fabric_archive}"
  printf '%s  %s\n' "${fabric_sha256}" "${fabric_archive}" | sha256sum --check --status \
    || die "Fabric archive checksum mismatch"
  fabric_staging="${fabric_tools}/.fabric-${fabric_version}-${fabric_arch}.staging"
  rm -rf "${fabric_staging}"
  install -d -m 0700 "${fabric_staging}"
  tar -C "${fabric_staging}" -xzf "${fabric_archive}"
  [ -x "${fabric_staging}/bin/peer" ] || die "Fabric archive lacks peer binary"
  [ -f "${fabric_staging}/config/core.yaml" ] || die "Fabric archive lacks core config"
  mv "${fabric_staging}" "${fabric_target}"
fi
ln -sfn "${fabric_target}" "${fabric_tools}/fabric-current"

PATH="${fabric_tools}/fabric-current/bin:${PATH}"
export PATH
for tool in peer cryptogen configtxgen osnadmin; do require_cmd "${tool}"; done
peer_version="$(peer version 2>/dev/null | awk '/Version:/{print $2; exit}')"
peer_version="${peer_version#v}"
[ "${peer_version}" = "${fabric_version}" ] || die "Fabric CLI version mismatch: expected ${fabric_version}, found ${peer_version:-unknown}"

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
