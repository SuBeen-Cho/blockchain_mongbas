#!/usr/bin/env bash
# booth-setup.sh — 새 컴퓨터에서 처음 한 번만 실행 (macOS · Linux · Windows WSL2)
#
#   ./scripts/booth-setup.sh      도구 설치 → 비밀값 생성 → 패키지 설치 → 원장 생성·체인코드 배포 → 화면 빌드
#   ./scripts/booth-up.sh         그다음부터는 이것만 실행 (부스 기동)
#
# 이미 원장이 있는 컴퓨터에서 다시 실행해도 원장·비밀값을 지우거나 덮어쓰지 않는다.
# 설치 위치는 모두 저장소 밖 ~/.local/state/mongbas (도구·비밀값·로그).
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source scripts/demo-process-lib.sh
demo_runtime_init
REPO="${DEMO_REPO_DIR}"
STATE_DIR="$(dirname "${DEMO_RUNTIME_DIR}")"
TOOLS="${STATE_DIR}/tools"
SECRET_DIR="${STATE_DIR}/secrets"
SECRET_ENV="${SECRET_DIR}/application.env"
FABRIC_VERSION="2.5.16"
CLOUDFLARED_VERSION="2026.11.1"

say() { printf '%s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ── 0. 운영체제 확인 ───────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "Windows에서는 WSL2 Ubuntu 터미널 안에서 실행해야 합니다. (BOOTH_QUICKSTART.md 참고)" ;;
esac
WSL=false
grep -qi microsoft /proc/version 2>/dev/null && WSL=true
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "지원하지 않는 CPU입니다: $(uname -m)" ;;
esac
if [ "${WSL}" = true ]; then
  case "${REPO}" in /mnt/*) fail "저장소가 Windows 드라이브(${REPO})에 있습니다. WSL 홈(~/)에 다시 clone 하세요. /mnt/c 아래는 Fabric이 매우 느리고 권한 오류가 납니다." ;; esac
fi
say "몽바스 부스 설치 진행 (${OS}/${ARCH}$([ "${WSL}" = true ] && printf ' · WSL2'))"

# ── 1. 필수 프로그램 확인 ─────────────────────────────────────────
say "[1/6] 필수 프로그램 확인"
missing=()
for c in git curl tar openssl python3 node npm docker; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if [ "${#missing[@]}" -gt 0 ]; then
  say "      없는 프로그램: ${missing[*]}"
  if [ "${OS}" = linux ]; then
    say "      Ubuntu 설치 예: sudo apt-get update && sudo apt-get install -y git curl tar openssl python3"
    say "      Node.js 22: https://nodejs.org (또는 nvm install 22)"
    [ "${WSL}" = true ] && say "      docker: Windows용 Docker Desktop 설치 → Settings › Resources › WSL integration에서 Ubuntu 켜기"
  else
    say "      macOS 설치 예: brew install node@22 python3 / Docker Desktop for Mac"
  fi
  fail "위 프로그램을 설치한 뒤 다시 실행하세요."
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node.js 22.12 이상이 필요합니다. (현재 $(node -v))"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2가 필요합니다. (docker compose version)"
if ! docker info >/dev/null 2>&1; then
  if [ "${OS}" = darwin ]; then
    say "      Docker Desktop 켜는 중"; open -a Docker
  elif [ "${WSL}" = true ] && [ -x "/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" ]; then
    say "      Docker Desktop 켜는 중"; ("/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" >/dev/null 2>&1 &)
  fi
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 3; done
  docker info >/dev/null 2>&1 || fail "Docker가 실행 중이 아니거나 권한이 없습니다. (Linux: sudo usermod -aG docker \$USER 후 재로그인)"
fi
say "      ✓ git · node $(node -v) · python3 · docker 확인"

# ── 2. Fabric 도구 · cloudflared (검증된 버전을 저장소 밖에 설치) ───
say "[2/6] Fabric ${FABRIC_VERSION} 도구 · cloudflared 설치 확인"
install -d -m 0700 "${TOOLS}" "${TOOLS}/bin"
download_verified() { # url sha256 out
  local tmp; tmp="$(mktemp)"
  curl --fail --location --retry 5 --silent --show-error "$1" -o "${tmp}" || { rm -f "${tmp}"; fail "다운로드 실패: $1"; }
  [ "$(sha256_of "${tmp}")" = "$2" ] || { rm -f "${tmp}"; fail "체크섬 불일치: $1"; }
  mv "${tmp}" "$3"
}
case "${OS}-${ARCH}" in
  linux-amd64) FABRIC_SHA=18c91e7f2f11b601e6622cc70454d568af897707ee9adf111e9fa91a233881bf ;;
  linux-arm64) FABRIC_SHA=c3c1809afab1998e9f2dd37ccd7fc5fa97658cdeaaa9ca0de29e896bf6dee029 ;;
  darwin-amd64) FABRIC_SHA=18acff3d9b782ddfc11b285af85f6e9f4a8d47504d8e6d230d1993f8e08833a6 ;;
  darwin-arm64) FABRIC_SHA=9f226e9c7e40f81b4f76db349438f8742beeb43d88519b73f2095e4f65f3ab42 ;;
esac
FABRIC_TARGET="${TOOLS}/fabric-${FABRIC_VERSION}-${OS}-${ARCH}"
if [ ! -x "${FABRIC_TARGET}/bin/peer" ] || [ ! -f "${FABRIC_TARGET}/config/core.yaml" ]; then
  say "      Fabric 도구 내려받는 중"
  archive="${TOOLS}/.fabric.tar.gz"
  download_verified "https://github.com/hyperledger/fabric/releases/download/v${FABRIC_VERSION}/hyperledger-fabric-${OS}-${ARCH}-${FABRIC_VERSION}.tar.gz" "${FABRIC_SHA}" "${archive}"
  staging="${FABRIC_TARGET}.staging"; rm -rf "${staging}"; install -d -m 0700 "${staging}"
  tar -C "${staging}" -xzf "${archive}"; rm -f "${archive}"
  [ -x "${staging}/bin/peer" ] || fail "Fabric 압축에 peer가 없습니다."
  rm -rf "${FABRIC_TARGET}"; mv "${staging}" "${FABRIC_TARGET}"
fi
ln -sfn "${FABRIC_TARGET}" "${TOOLS}/fabric-current"
export PATH="${TOOLS}/fabric-current/bin:${TOOLS}/bin:${PATH}"
say "      ✓ Fabric $(peer version 2>/dev/null | awk '/Version:/{print $2; exit}')"

if ! command -v cloudflared >/dev/null 2>&1; then
  if [ "${OS}" = darwin ]; then
    command -v brew >/dev/null 2>&1 || fail "cloudflared가 없습니다. Homebrew 설치 후 brew install cloudflared"
    brew install cloudflared
  else
    case "${ARCH}" in
      amd64) CF_SHA=97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7 ;;
      arm64) CF_SHA=b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a ;;
    esac
    say "      cloudflared 내려받는 중"
    download_verified "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${ARCH}" "${CF_SHA}" "${TOOLS}/bin/cloudflared"
    chmod 0755 "${TOOLS}/bin/cloudflared"
  fi
fi
say "      ✓ cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3; exit}')"

# ── 3. 비밀값 (처음 한 번 생성, 저장소 밖 · 기존 값 보존) ───────────
say "[3/6] 서버 비밀값 확인"
if [ -e application/.env ] || [ -L application/.env ]; then
  say "      ✓ 기존 application/.env 유지"
else
  install -d -m 0700 "${SECRET_DIR}"
  if [ ! -f "${SECRET_ENV}" ]; then
    rnd() { openssl rand -base64 48 | tr -d '\n'; }
    ed="$(node application/scripts/generate-ed25519-env.js)"
    umask 077
    {
      echo "# 몽바스 부스 서버 비밀값 — booth-setup.sh가 $(date +%F)에 생성. Git에 올리지 말 것"
      echo "PORT=3000"
      echo "NODE_ENV=development"
      echo "IDEMIX_ENABLED=true"
      echo "ASYM_CRED_ENABLED=true"
      echo "CREDENTIAL_TTL_SEC=600"
      echo "CREDENTIAL_AUDIT_ENABLED=true"
      echo "DISABLE_RATE_LIMITS=false"
      echo "CREDENTIAL_SECRET=$(rnd)"
      echo "AUDIT_HMAC_KEY=$(rnd)"
      printf '%s\n' "${ed}" | grep -E '^ED25519_(PRIVATE|PUBLIC)_KEY_DER_B64='
    } > "${SECRET_ENV}"
    chmod 0600 "${SECRET_ENV}"
    unset ed
    say "      ✓ 새 비밀값 생성 (${SECRET_ENV})"
  fi
  ln -s "${SECRET_ENV}" application/.env
  say "      ✓ application/.env → 저장소 밖 비밀값 연결"
fi

# ── 4. 패키지 설치 · 화면 빌드 ─────────────────────────────────────
say "[4/6] 패키지 설치 · 화면 빌드 (처음엔 몇 분)"
(cd application && npm ci --no-audit --no-fund --loglevel=error)
(cd frontend && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null)
say "      ✓ application · frontend 준비"

# ── 5. Fabric 원장 생성 · 체인코드 배포 (없을 때만) ─────────────────
say "[5/6] Fabric 원장 확인"
running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }
exists() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }
if exists peer0.ec.voting.example.com; then
  say "      ✓ 기존 원장이 있어 그대로 사용 (지우지 않음)"
else
  [ ! -e network/crypto-config ] && [ ! -e network/channel-artifacts ] \
    || fail "컨테이너는 없는데 network/crypto-config가 남아 있습니다. 예전 원장 흔적이므로 확인 후 직접 정리하세요."
  set -a; . application/.env; set +a
  export MONGBAS_RUNTIME_DIR="${STATE_DIR}"
  say "      새 원장 생성 진행 (이미지 내려받기 포함 5~15분)"
  (cd network && ./scripts/network.sh up && ./scripts/network.sh deploy)
  say "      ✓ 원장 생성 · 체인코드 배포 완료"
fi
names="$(docker ps --format '{{.Names}}' | grep -E 'peer|orderer|couchdb|voting-chaincode|^cli$' || true)"
[ -z "${names}" ] || docker update --restart unless-stopped ${names} >/dev/null
say "      ✓ 컨테이너 자동 재시작 설정"

# ── 6. 마무리 ─────────────────────────────────────────────────────
say "[6/6] 설치 완료"
cat <<EOF

  ✅ 설치가 끝났습니다. 이제부터는 이것만 실행하면 됩니다:

      ./scripts/booth-up.sh

  비밀값·도구·로그 위치 : ${STATE_DIR}  (Git에 올리지 않음)
EOF
