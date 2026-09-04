#!/bin/bash
# network.sh v2.0 — BFT 전자투표 네트워크 관리 스크립트
#
# 사용법:
#   ./scripts/network.sh up       — 인증서 생성 → 제네시스 블록 → 네트워크 실행
#   ./scripts/network.sh down     — 컨테이너 종료 및 볼륨 삭제
#   ./scripts/network.sh deploy   — 체인코드 3개 기관 배포 (2-of-3 승인 포함)
#   ./scripts/network.sh test     — 기본 투표 시나리오 테스트
#   ./scripts/network.sh clean    — 인증서·아티팩트 포함 완전 초기화
#
# 조직 구성 (configtx.yaml, crypto-config.yaml 과 일치):
#   ElectionCommissionMSP  : peer0.ec (7051), peer1.ec (7151)
#   PartyObserverMSP       : peer0.party (8051)
#   CivilSocietyMSP        : peer0.civil (9051)
#
# n-of-m 정책: 3개 기관 중 2개 이상 승인 필요 (OutOf 2-of-3)

set -euo pipefail

case "${1:-}" in
  down|clean)
    if [ "$#" -ne 2 ] || [ "$2" != "--confirm-destroy-ledger" ]; then
      echo "REFUSED: $1 deletes Fabric volumes and ledger data" >&2
      echo "usage: $0 $1 --confirm-destroy-ledger" >&2
      exit 2
    fi
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_NETWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$DEFAULT_NETWORK_DIR/.." && pwd)"
NETWORK_DIR="${FABRIC_NETWORK_DIR:-$DEFAULT_NETWORK_DIR}"
CHAINCODE_SOURCE_DIR="${MONGBAS_CHAINCODE_SOURCE_DIR:-$PROJECT_DIR/chaincode/voting}"
case "$NETWORK_DIR" in /*) ;; *) echo "FABRIC_NETWORK_DIR must be absolute" >&2; exit 1 ;; esac
case "$CHAINCODE_SOURCE_DIR" in /*) ;; *) echo "MONGBAS_CHAINCODE_SOURCE_DIR must be absolute" >&2; exit 1 ;; esac
[ -f "$NETWORK_DIR/docker-compose.yaml" ] || { echo "Fabric network artifacts missing: $NETWORK_DIR" >&2; exit 1; }
[ -f "$CHAINCODE_SOURCE_DIR/Dockerfile" ] || { echo "chaincode source missing: $CHAINCODE_SOURCE_DIR" >&2; exit 1; }

# Linux bootstrap이 private runtime에 설치한 검증된 pinned toolset을
# 최우선한다. 기존 repo-local/Mac fabric-samples 경로는 하위 호환이다.
if [ -n "${MONGBAS_RUNTIME_DIR:-}" ] && [ -x "${MONGBAS_RUNTIME_DIR}/tools/fabric-current/bin/peer" ]; then
  FABRIC_BIN="${MONGBAS_RUNTIME_DIR}/tools/fabric-current/bin"
  PEER_CFG_PATH="${MONGBAS_RUNTIME_DIR}/tools/fabric-current/config"
elif [ -d "${PROJECT_DIR}/bin" ]; then
  FABRIC_BIN="${PROJECT_DIR}/bin"
  PEER_CFG_PATH="${PROJECT_DIR}/config"
else
  FABRIC_BIN="${PROJECT_DIR}/fabric-samples/bin"
  PEER_CFG_PATH="${PROJECT_DIR}/fabric-samples/config"
fi
export PATH="${FABRIC_BIN}:${PATH}"

CHANNEL_NAME="voting-channel"
CHAINCODE_NAME="voting"
CHAINCODE_VERSION="1.0"
CHAINCODE_PATH="${CHAINCODE_SOURCE_DIR}"
CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}"
FABRIC_CFG_PATH="${NETWORK_DIR}"

CRYPTO="${NETWORK_DIR}/crypto-config"

# ── 오더러 CA ─────────────────────────────────────────────────
ORDERER_CA="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/orderers/orderer1.orderer.voting.example.com/tls/ca.crt"

# ── 조직별 Admin MSP 경로 ──────────────────────────────────────
EC_ADMIN_MSP="${CRYPTO}/peerOrganizations/ec.voting.example.com/users/Admin@ec.voting.example.com/msp"
PARTY_ADMIN_MSP="${CRYPTO}/peerOrganizations/party.voting.example.com/users/Admin@party.voting.example.com/msp"
CIVIL_ADMIN_MSP="${CRYPTO}/peerOrganizations/civil.voting.example.com/users/Admin@civil.voting.example.com/msp"

# ── 조직별 피어 TLS CA ─────────────────────────────────────────
EC0_TLS="${CRYPTO}/peerOrganizations/ec.voting.example.com/peers/peer0.ec.voting.example.com/tls/ca.crt"
EC1_TLS="${CRYPTO}/peerOrganizations/ec.voting.example.com/peers/peer1.ec.voting.example.com/tls/ca.crt"
PARTY_TLS="${CRYPTO}/peerOrganizations/party.voting.example.com/peers/peer0.party.voting.example.com/tls/ca.crt"
CIVIL_TLS="${CRYPTO}/peerOrganizations/civil.voting.example.com/peers/peer0.civil.voting.example.com/tls/ca.crt"

# ── 피어 주소 ──────────────────────────────────────────────────
EC0_ADDR="localhost:7051"
EC1_ADDR="localhost:7151"
PARTY_ADDR="localhost:8051"
CIVIL_ADDR="localhost:9051"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
step()    { echo -e "${CYAN}[STEP]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ──────────────────────────────────────────────────────────────
# 환경변수 헬퍼: 특정 조직·피어로 전환
# ──────────────────────────────────────────────────────────────
use_ec0() {
  export FABRIC_CFG_PATH="${PEER_CFG_PATH}"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID=ElectionCommissionMSP
  export CORE_PEER_MSPCONFIGPATH="${EC_ADMIN_MSP}"
  export CORE_PEER_ADDRESS="${EC0_ADDR}"
  export CORE_PEER_TLS_ROOTCERT_FILE="${EC0_TLS}"
}

use_ec1() {
  export FABRIC_CFG_PATH="${PEER_CFG_PATH}"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID=ElectionCommissionMSP
  export CORE_PEER_MSPCONFIGPATH="${EC_ADMIN_MSP}"
  export CORE_PEER_ADDRESS="${EC1_ADDR}"
  export CORE_PEER_TLS_ROOTCERT_FILE="${EC1_TLS}"
}

use_party() {
  export FABRIC_CFG_PATH="${PEER_CFG_PATH}"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID=PartyObserverMSP
  export CORE_PEER_MSPCONFIGPATH="${PARTY_ADMIN_MSP}"
  export CORE_PEER_ADDRESS="${PARTY_ADDR}"
  export CORE_PEER_TLS_ROOTCERT_FILE="${PARTY_TLS}"
}

use_civil() {
  export FABRIC_CFG_PATH="${PEER_CFG_PATH}"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID=CivilSocietyMSP
  export CORE_PEER_MSPCONFIGPATH="${CIVIL_ADMIN_MSP}"
  export CORE_PEER_ADDRESS="${CIVIL_ADDR}"
  export CORE_PEER_TLS_ROOTCERT_FILE="${CIVIL_TLS}"
}

# ──────────────────────────────────────────────────────────────
# 의존성 확인
# ──────────────────────────────────────────────────────────────
check_deps() {
  for cmd in cryptogen configtxgen docker peer python3; do
    command -v "$cmd" &>/dev/null || error "$cmd 가 PATH에 없습니다."
  done
  info "의존성 확인 완료"
}

# ──────────────────────────────────────────────────────────────
# Step 1: 인증서 생성 (cryptogen)
# ──────────────────────────────────────────────────────────────
generate_crypto() {
  step "1/5 인증서 생성 (cryptogen)..."
  cd "$NETWORK_DIR"
  if [ -e crypto-config ] || [ -e channel-artifacts ]; then
    error "REFUSED: existing crypto-config or channel-artifacts must be preserved; use an explicitly approved clean/reset workflow"
  fi
  cryptogen generate --config=./crypto-config.yaml --output=./crypto-config
  info "인증서 생성 완료 → ${NETWORK_DIR}/crypto-config/"
}

# ──────────────────────────────────────────────────────────────
# Step 2: 제네시스 블록 생성 (configtxgen)
# ──────────────────────────────────────────────────────────────
generate_genesis() {
  step "2/5 제네시스 블록 생성 (configtxgen)..."
  cd "$NETWORK_DIR"
  export FABRIC_CFG_PATH="${NETWORK_DIR}"
  mkdir -p channel-artifacts
  configtxgen \
    -profile VotingNetworkGenesis \
    -outputBlock ./channel-artifacts/genesis.block \
    -channelID "${CHANNEL_NAME}" \
    -configPath .
  info "제네시스 블록 완료 → channel-artifacts/genesis.block"
}

# ──────────────────────────────────────────────────────────────
# Step 3: Docker 네트워크 실행
# ──────────────────────────────────────────────────────────────
start_network() {
  step "3/5 Docker 컨테이너 실행..."
  cd "$NETWORK_DIR"
  docker compose up -d
  info "컨테이너 기동 대기 (35초)..."
  sleep 35
  docker compose ps
}

# ──────────────────────────────────────────────────────────────
# Step 4: 오더러 4개를 채널에 참여 (osnadmin channel join)
# ──────────────────────────────────────────────────────────────
join_orderers() {
  step "4/5 오더러 채널 참여 (osnadmin channel join)..."
  cd "$NETWORK_DIR"

  ORDERER_ADMIN_CA="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/orderers/orderer1.orderer.voting.example.com/tls/ca.crt"
  ADMIN_TLS_CERT="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/users/Admin@orderer.voting.example.com/tls/client.crt"
  ADMIN_TLS_KEY="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/users/Admin@orderer.voting.example.com/tls/client.key"
  GENESIS="${NETWORK_DIR}/channel-artifacts/genesis.block"

  for PORT in 7053 7153 7253 7353; do
    info "  오더러 admin:${PORT} 채널 참여..."
    JOIN_OUTPUT=$(osnadmin channel join \
      --channelID "${CHANNEL_NAME}" \
      --config-block "${GENESIS}" \
      -o "localhost:${PORT}" \
      --ca-file   "${ORDERER_ADMIN_CA}" \
      --client-cert "${ADMIN_TLS_CERT}" \
      --client-key  "${ADMIN_TLS_KEY}" \
      2>&1)
    printf '%s\n' "${JOIN_OUTPUT}" | grep -E "Status|error|channel" || printf '%s\n' "${JOIN_OUTPUT}"
  done

  info "오더러 채널 참여 완료. 합의 형성 대기 (5초)..."
  sleep 5
}

# ──────────────────────────────────────────────────────────────
# Step 5: 피어 4개를 채널에 참여 (peer channel join)
# ──────────────────────────────────────────────────────────────
join_peers() {
  step "5/5 피어 채널 참여 (peer channel join)..."
  GENESIS="${NETWORK_DIR}/channel-artifacts/genesis.block"

  info "  peer0.ec 채널 참여..."
  use_ec0
  peer channel join -b "${GENESIS}"

  info "  peer1.ec 채널 참여..."
  use_ec1
  peer channel join -b "${GENESIS}"

  info "  peer0.party 채널 참여..."
  use_party
  peer channel join -b "${GENESIS}"

  info "  peer0.civil 채널 참여..."
  use_civil
  peer channel join -b "${GENESIS}"

  info "피어 채널 참여 완료"
}

# ──────────────────────────────────────────────────────────────
# cmd_up: 전체 네트워크 구동
# ──────────────────────────────────────────────────────────────
cmd_up() {
  check_deps
  generate_crypto
  generate_genesis
  start_network
  join_orderers
  join_peers
  echo ""
  info "네트워크 구동 완료!"
  echo ""
  echo "  [선관위] peer0.ec  : ${EC0_ADDR}   couchdb-ec0  : http://localhost:5984"
  echo "  [선관위] peer1.ec  : ${EC1_ADDR}   couchdb-ec1  : http://localhost:5985"
  echo "  [정당]   peer0.party: ${PARTY_ADDR}  couchdb-party: http://localhost:6984"
  echo "  [시민]   peer0.civil: ${CIVIL_ADDR}  couchdb-civil: http://localhost:7984"
  echo ""
  echo "  다음 단계: ./scripts/network.sh deploy"
}

# ──────────────────────────────────────────────────────────────
# cmd_deploy: 체인코드 배포 (CCAAS 방식 — macOS Docker Desktop 호환)
#
# CCAAS (Chaincode as a Service) 배포 흐름:
#   1. CCAAS 패키지 생성 (connection.json + metadata.json)
#   2. 4개 피어에 설치
#   3. 패키지 ID 조회 → voting-chaincode 컨테이너에 주입
#   4. 3개 기관 승인 → 커밋 → 최초 정의에서만 InitLedger
# ──────────────────────────────────────────────────────────────
cmd_deploy() {
  cd "$NETWORK_DIR"

  # HMAC credential은 API와 chaincode가 같은 secret으로 각각 검증한다.
  # 누락된 상태로 배포하면 체인코드 검증이 우회되는 구성이 되므로 fail closed.
  if [ -z "${CREDENTIAL_SECRET:-}" ]; then
    error "CREDENTIAL_SECRET 미설정: 최소 32바이트 secret을 환경변수로 전달해야 합니다. 값은 로그에 출력하지 않습니다."
  fi
  if [ "$(printf '%s' "${CREDENTIAL_SECRET}" | wc -c | tr -d ' ')" -lt 32 ]; then
    error "CREDENTIAL_SECRET 길이 부족: 최소 32바이트가 필요합니다."
  fi

  # The compose/build tag is mutable. Before an upgrade rebuilds it, preserve
  # the exact running image under the committed sequence so a failed rollout
  # has an executable recovery point. First deployment has no prior image.
  use_ec0
  CURRENT_SEQ_BEFORE_BUILD=$(peer lifecycle chaincode querycommitted \
    --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" \
    --output json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sequence',0))" 2>/dev/null || echo "0")
  NEXT_SEQ_BEFORE_BUILD=$((CURRENT_SEQ_BEFORE_BUILD + 1))
  DEPLOY_IMAGE_TAG="voting-chaincode:1.0"
  CHAINCODE_CONTAINER_NAME="voting-chaincode"
  if [ "${CURRENT_SEQ_BEFORE_BUILD}" -gt 0 ]; then
    # A CCAAS package binds connection metadata, not the executable image.
    # Use a new package label and network address so the current definition
    # continues to execute the old container until lifecycle commit succeeds.
    # Fabric lifecycle version is descriptive application metadata and must
    # also change when a new executable package is committed.
    CHAINCODE_VERSION="${CHAINCODE_VERSION}.seq${NEXT_SEQ_BEFORE_BUILD}"
    CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}_seq${NEXT_SEQ_BEFORE_BUILD}"
    DEPLOY_IMAGE_TAG="voting-chaincode:candidate-seq-${NEXT_SEQ_BEFORE_BUILD}"
    CHAINCODE_CONTAINER_NAME="voting-chaincode-seq-${NEXT_SEQ_BEFORE_BUILD}"
  fi
  if [ "${CURRENT_SEQ_BEFORE_BUILD}" -gt 0 ]; then
    CURRENT_IMAGE_ID=$(docker image inspect voting-chaincode:1.0 --format '{{.Id}}' 2>/dev/null) \
      || error "기존 sequence ${CURRENT_SEQ_BEFORE_BUILD} chaincode image가 없어 안전한 upgrade 복구 지점을 만들 수 없습니다."
    ROLLBACK_IMAGE_TAG="voting-chaincode:rollback-seq-${CURRENT_SEQ_BEFORE_BUILD}"
    if ROLLBACK_IMAGE_ID=$(docker image inspect "${ROLLBACK_IMAGE_TAG}" --format '{{.Id}}' 2>/dev/null); then
      [ "${ROLLBACK_IMAGE_ID}" = "${CURRENT_IMAGE_ID}" ] \
        || error "${ROLLBACK_IMAGE_TAG}가 현재 실행 image와 달라 덮어쓰기를 거부합니다."
    else
      docker image tag "${CURRENT_IMAGE_ID}" "${ROLLBACK_IMAGE_TAG}"
    fi
    info "upgrade recovery image 보존: ${ROLLBACK_IMAGE_TAG} (${CURRENT_IMAGE_ID})"
  fi

  # ── CCAAS 패키지 생성 ─────────────────────────────────────────
  # A CCAAS package contains connection metadata only. Rebuild the executable
  # image so a lifecycle upgrade never restarts stale chaincode code.
  step "[배포 0/7] 현재 소스로 CCAAS 이미지 재빌드..."
  if [ "${CURRENT_SEQ_BEFORE_BUILD}" -eq 0 ] && \
     [ "${NETWORK_DIR}" = "${DEFAULT_NETWORK_DIR}" ] && [ "${CHAINCODE_PATH}" = "${PROJECT_DIR}/chaincode/voting" ]; then
    docker compose -f "${NETWORK_DIR}/docker-compose.yaml" build voting-chaincode
  else
    # A feature checkout may intentionally keep Fabric identities and channel
    # artifacts in a protected operational checkout. Build the executable from
    # the explicitly selected source instead of the compose file's relative
    # context, which may otherwise rebuild stale main-branch code.
    docker build -t "${DEPLOY_IMAGE_TAG}" "${CHAINCODE_PATH}"
  fi

  step "[배포 1/7] CCAAS 패키지 생성..."
  CCAAS_PKG=$(mktemp -d "${TMPDIR:-/tmp}/mongbas-voting-ccaas.XXXXXX")
  chmod 0700 "${CCAAS_PKG}"
  cleanup_ccaas_pkg() {
    if [ -n "${CCAAS_PKG:-}" ] && [ -d "${CCAAS_PKG}" ]; then
      rm -rf -- "${CCAAS_PKG}"
    fi
  }
  trap cleanup_ccaas_pkg EXIT

  # connection.json: 피어가 체인코드 서비스에 연결할 주소
  cat > "${CCAAS_PKG}/connection.json" << EOF
{
  "address": "${CHAINCODE_CONTAINER_NAME}:7052",
  "dial_timeout": "10s",
  "tls_required": false
}
EOF

  # metadata.json: ccaas 외부 빌더 감지용 type 필드
  # peer 내장 ccaas_builder는 "ccaas" 타입을 감지함
  cat > "${CCAAS_PKG}/metadata.json" << EOF
{
  "type": "ccaas",
  "label": "${CHAINCODE_LABEL}"
}
EOF

  cd "${CCAAS_PKG}"
  # macOS가 AppleDouble (._*) metadata를 archive에 넣으면 같은 입력에서도
  # package ID가 달라지고 Fabric이 경고한다. Linux에서는 이 변수가 무해하다.
  COPYFILE_DISABLE=1 tar czf code.tar.gz connection.json
  COPYFILE_DISABLE=1 tar czf "${NETWORK_DIR}/${CHAINCODE_LABEL}_ccaas.tar.gz" code.tar.gz metadata.json
  cd "${NETWORK_DIR}"
  rm -rf -- "${CCAAS_PKG}"
  CCAAS_PKG=""
  trap - EXIT
  info "CCAAS 패키지 완료: ${CHAINCODE_LABEL}_ccaas.tar.gz"

  # ── 4개 피어 전체 설치 ───────────────────────────────────────
  step "[배포 2/7] 4개 피어에 CCAAS 패키지 설치..."

  info "  설치: peer0.ec (선관위)"
  use_ec0
  peer lifecycle chaincode install "${CHAINCODE_LABEL}_ccaas.tar.gz"

  info "  설치: peer1.ec (선관위 보조)"
  use_ec1
  peer lifecycle chaincode install "${CHAINCODE_LABEL}_ccaas.tar.gz"

  info "  설치: peer0.party (참관 정당)"
  use_party
  peer lifecycle chaincode install "${CHAINCODE_LABEL}_ccaas.tar.gz"

  info "  설치: peer0.civil (시민단체)"
  use_civil
  peer lifecycle chaincode install "${CHAINCODE_LABEL}_ccaas.tar.gz"

  # ── 패키지 ID 조회 + voting-chaincode 컨테이너에 주입 ────────
  step "[배포 3/7] 패키지 ID 조회 및 CCAAS 컨테이너 기동..."
  use_ec0
  # queryinstalled의 첫 항목은 동일 label의 과거 패키지일 수 있다. 방금 만든
  # archive에서 결정론적으로 계산한 ID를 사용하고 실제 설치 여부를 확인한다.
  PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid "${CHAINCODE_LABEL}_ccaas.tar.gz")
  peer lifecycle chaincode queryinstalled --output json \
    | python3 -c 'import json,sys; expected=sys.argv[1]; data=json.load(sys.stdin); ids={x["package_id"] for x in data.get("installed_chaincodes", [])}; sys.exit(0 if expected in ids else 1)' "${PACKAGE_ID}" \
    || error "방금 생성한 CCAAS package ID가 peer0.ec 설치 목록에 없습니다."
  info "Package ID: ${PACKAGE_ID}"

  # First deployment owns the conventional container. An upgrade starts a
  # sequence-bound candidate alongside the still-live prior definition.
  info "  CCAAS candidate에 CHAINCODE_ID 주입..."
  if [ -z "${ED25519_PUBLIC_KEY_DER_B64:-}" ]; then
    warn "  ED25519_PUBLIC_KEY_DER_B64 미설정: ed25519 credential의 체인코드 직접 검증은 실패합니다."
    warn "  application 디렉터리에서 'npm run keys:ed25519'로 키를 생성한 뒤 공개키를 export 하세요."
  fi
  cd "$NETWORK_DIR"
  if [ "${CURRENT_SEQ_BEFORE_BUILD}" -eq 0 ]; then
    docker rm -f voting-chaincode 2>/dev/null || true
  else
    if docker inspect "${CHAINCODE_CONTAINER_NAME}" >/dev/null 2>&1; then
      error "candidate container already exists; refusing to replace it: ${CHAINCODE_CONTAINER_NAME}"
    fi
  fi
  docker run -d \
    --name "${CHAINCODE_CONTAINER_NAME}" \
    --network voting-net \
    --user 65532:65532 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:7052 \
    -e CHAINCODE_ID="${PACKAGE_ID}" \
    -e CREDENTIAL_SECRET="${CREDENTIAL_SECRET}" \
    -e ED25519_PUBLIC_KEY_DER_B64="${ED25519_PUBLIC_KEY_DER_B64:-}" \
    -e PS_ISSUER_PUBLIC_KEY_B64="${PS_ISSUER_PUBLIC_KEY_B64:-}" \
    -e BBS_PUBLIC_KEY_B64="${BBS_PUBLIC_KEY_B64:-}" \
    -e ALLOW_BYPASS_CREDENTIAL="${ALLOW_BYPASS_CREDENTIAL:-false}" \
    "${DEPLOY_IMAGE_TAG}"
  info "  CCAAS candidate 기동 완료: ${CHAINCODE_CONTAINER_NAME} (PackageID: ${PACKAGE_ID:0:40}...)"
  sleep 3
  CANDIDATE_RUNNING=$(docker inspect -f '{{.State.Running}}' "${CHAINCODE_CONTAINER_NAME}" 2>/dev/null || true)
  [ "${CANDIDATE_RUNNING}" = "true" ] \
    || error "candidate failed to remain running before lifecycle approval"

  # ── 현재 커밋된 시퀀스 조회 → 다음 시퀀스 계산 ─────────────
  use_ec0
  CURRENT_SEQ=$(peer lifecycle chaincode querycommitted \
    --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" \
    --output json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sequence',0))" 2>/dev/null || echo "0")
  [ "${CURRENT_SEQ}" = "${CURRENT_SEQ_BEFORE_BUILD}" ] \
    || error "definition changed during chaincode build/install: expected sequence ${CURRENT_SEQ_BEFORE_BUILD}, got ${CURRENT_SEQ}"
  NEXT_SEQ="${NEXT_SEQ_BEFORE_BUILD}"
  info "현재 시퀀스: ${CURRENT_SEQ} → 다음 시퀀스: ${NEXT_SEQ}"

  # ── 3개 기관 각각 승인 (n-of-m 핵심) ────────────────────────
  step "[배포 4/7] 3개 기관 체인코드 승인 (각 기관이 독립적으로 서명)..."

  APPROVE_COMMON=(
    --channelID "${CHANNEL_NAME}"
    --name "${CHAINCODE_NAME}"
    --version "${CHAINCODE_VERSION}"
    --package-id "${PACKAGE_ID}"
    --sequence "${NEXT_SEQ}"
    --collections-config "${CHAINCODE_PATH}/collection_config.json"
    --tls
    --cafile "${ORDERER_CA}"
    --orderer localhost:7050
  )

  info "  승인: ElectionCommissionMSP (선관위)"
  use_ec0
  peer lifecycle chaincode approveformyorg "${APPROVE_COMMON[@]}"

  info "  승인: PartyObserverMSP (참관 정당)"
  use_party
  peer lifecycle chaincode approveformyorg "${APPROVE_COMMON[@]}"

  info "  승인: CivilSocietyMSP (시민단체)"
  use_civil
  peer lifecycle chaincode approveformyorg "${APPROVE_COMMON[@]}"

  # ── 커밋 준비 확인 (3/3 모두 true 확인) ─────────────────────
  step "[배포 5/7] 커밋 준비 상태 확인..."
  use_ec0
  READINESS_JSON=$(peer lifecycle chaincode checkcommitreadiness \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --version "${CHAINCODE_VERSION}" \
    --sequence "${NEXT_SEQ}" \
    --collections-config "${CHAINCODE_PATH}/collection_config.json" \
    --output json)
  printf '%s\n' "${READINESS_JSON}"
  printf '%s' "${READINESS_JSON}" | python3 -c \
    'import json,sys; a=json.load(sys.stdin).get("approvals",{}); required=["ElectionCommissionMSP","PartyObserverMSP","CivilSocietyMSP"]; sys.exit(0 if all(a.get(m) is True for m in required) else 1)' \
    || error "all required MSP approvals are not ready; refusing chaincode commit"

  # ── 커밋 (2-of-3 충족: 선관위 + 참관 정당 피어를 endorser로 지정) ──
  step "[배포 6/7] 체인코드 커밋 (선관위 + 참관 정당 피어로 2-of-3 충족)..."
  use_ec0
  peer lifecycle chaincode commit \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --version "${CHAINCODE_VERSION}" \
    --sequence "${NEXT_SEQ}" \
    --collections-config "${CHAINCODE_PATH}/collection_config.json" \
    --tls \
    --cafile "${ORDERER_CA}" \
    --orderer localhost:7050 \
    --peerAddresses "${EC0_ADDR}"    --tlsRootCertFiles "${EC0_TLS}" \
    --peerAddresses "${PARTY_ADDR}"  --tlsRootCertFiles "${PARTY_TLS}" \
    --peerAddresses "${CIVIL_ADDR}"  --tlsRootCertFiles "${CIVIL_TLS}"

  COMMITTED_JSON=$(peer lifecycle chaincode querycommitted \
    --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" --output json)
  printf '%s\n' "${COMMITTED_JSON}"
  printf '%s' "${COMMITTED_JSON}" | python3 -c \
    'import json,sys; d=json.load(sys.stdin); expected_seq=int(sys.argv[1]); expected_version=sys.argv[2]; sys.exit(0 if d.get("sequence")==expected_seq and d.get("version")==expected_version else 1)' \
    "${NEXT_SEQ}" "${CHAINCODE_VERSION}" \
    || error "committed chaincode definition does not match requested sequence/version"
  use_ec0
  CANDIDATE_CALLABLE=false
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    if peer chaincode query \
      --channelID "${CHANNEL_NAME}" \
      --name "${CHAINCODE_NAME}" \
      --ctor '{"function":"GetSecurityProperties","Args":[]}' >/dev/null 2>&1; then
      CANDIDATE_CALLABLE=true
      break
    fi
    sleep 3
  done
  [ "${CANDIDATE_CALLABLE}" = "true" ] \
    || error "committed candidate chaincode is not callable"
  if [ "${CURRENT_SEQ_BEFORE_BUILD}" -gt 0 ]; then
    docker image tag "${DEPLOY_IMAGE_TAG}" voting-chaincode:1.0
    info "mutable current image tag advanced after verified commit: ${DEPLOY_IMAGE_TAG}"
  fi

  # InitLedger is a first-deployment operation. Re-invoking it during an
  # upgrade adds an unrelated ledger mutation and makes preservation evidence
  # ambiguous even if the implementation happens to be idempotent.
  if [ "${CURRENT_SEQ}" -eq 0 ]; then
    step "[배포 7/7] 최초 InitLedger 호출..."
    use_ec0
    peer chaincode invoke \
      --channelID "${CHANNEL_NAME}" \
      --name "${CHAINCODE_NAME}" \
      --ctor '{"function":"InitLedger","Args":[]}' \
      --tls \
      --cafile "${ORDERER_CA}" \
      --orderer localhost:7050 \
      --peerAddresses "${EC0_ADDR}"   --tlsRootCertFiles "${EC0_TLS}" \
      --peerAddresses "${PARTY_ADDR}" --tlsRootCertFiles "${PARTY_TLS}" \
      --waitForEvent
  else
    info "[배포 7/7] 기존 sequence ${CURRENT_SEQ} upgrade: InitLedger를 호출하지 않습니다."
  fi

  echo ""
  info "체인코드 배포 완료! (3개 기관 승인 / 2-of-3 커밋)"
}

# ──────────────────────────────────────────────────────────────
# cmd_test: 기본 투표 시나리오 smoke test
# ──────────────────────────────────────────────────────────────
cmd_test() {
  info "투표 시나리오 테스트 시작..."

  ELECTION_ID="ELECTION_2026_PRESIDENT"
  CANDIDATE_ID="CANDIDATE_A"
  VOTER_SECRET="secret_voter_1"
  NULLIFIER_HASH=$(echo -n "${VOTER_SECRET}${ELECTION_ID}" | sha256sum | awk '{print $1}')

  # ── 선거 조회 (읽기 — 단일 피어) ────────────────────────────
  step "[테스트 1/4] 선거 정보 조회..."
  use_ec0
  peer chaincode query \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"GetElection\",\"Args\":[\"${ELECTION_ID}\"]}"

  # ── 투표 제출 (쓰기 — 2-of-3 endorsement 필수) ──────────────
  step "[테스트 2/4] 투표 제출 (선관위 + 참관 정당 서명으로 2-of-3 충족)..."
  info "  nullifier: ${NULLIFIER_HASH:0:24}..."

  PRIVATE_JSON=$(printf '{"docType":"votePrivate","voterID":"voter001_encrypted","electionID":"%s","candidateID":"%s","nullifierHash":"%s","voteHash":"sha256_placeholder"}' \
    "${ELECTION_ID}" "${CANDIDATE_ID}" "${NULLIFIER_HASH}")
  PRIVATE_DATA=$(echo -n "${PRIVATE_JSON}" | base64 | tr -d '\n')

  use_ec0
  peer chaincode invoke \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"CastVote\",\"Args\":[\"${ELECTION_ID}\",\"${CANDIDATE_ID}\",\"${NULLIFIER_HASH}\"]}" \
    --transient "{\"votePrivate\":\"${PRIVATE_DATA}\"}" \
    --tls \
    --cafile "${ORDERER_CA}" \
    --orderer localhost:7050 \
    --peerAddresses "${EC0_ADDR}"   --tlsRootCertFiles "${EC0_TLS}" \
    --peerAddresses "${PARTY_ADDR}" --tlsRootCertFiles "${PARTY_TLS}" \
    --waitForEvent

  # ── Nullifier 확인 (이중투표 방지) ──────────────────────────
  step "[테스트 3/4] Nullifier 확인 (이중투표 방지)..."
  use_ec0
  NULLIFIER_RESULT=$(peer chaincode query \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"GetNullifier\",\"Args\":[\"${NULLIFIER_HASH}\"]}")
  python3 - "${NULLIFIER_HASH}" "${ELECTION_ID}" "${NULLIFIER_RESULT}" <<'PY'
import json
import sys

expected_nullifier, expected_election, raw = sys.argv[1:]
try:
    record = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"Nullifier query did not return JSON: {exc}: {raw!r}")
if record.get("docType") != "nullifier":
    raise SystemExit(f"unexpected docType: {record.get('docType')!r}")
if record.get("nullifierHash") != expected_nullifier:
    raise SystemExit("ledger nullifierHash mismatch")
if record.get("electionID") != expected_election:
    raise SystemExit("ledger electionID mismatch")
if record.get("evictCount") != 0:
    raise SystemExit(f"first vote evictCount must be 0, got {record.get('evictCount')!r}")
PY

  # ── 재투표(Eviction) 확인 — 같은 Nullifier로 후보 변경 ────────
  # 설계: 동일 Nullifier 재사용 시 기존 투표를 덮어쓰고 evictCount 증가
  # 최종 집계에는 1표만 반영됨 (이중 집계 없음)
  step "[테스트 4/4] 재투표(Eviction) 확인 — evictCount 증가 검증..."
  CANDIDATE_ID_B="CANDIDATE_B"
  use_ec0
  PRIVATE_JSON_B=$(printf '{"docType":"votePrivate","voterID":"voter001_encrypted","electionID":"%s","candidateID":"%s","nullifierHash":"%s","voteHash":"sha256_placeholder"}' \
    "${ELECTION_ID}" "${CANDIDATE_ID_B}" "${NULLIFIER_HASH}")
  PRIVATE_DATA_B=$(echo -n "${PRIVATE_JSON_B}" | base64 | tr -d '\n')

  peer chaincode invoke \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"CastVote\",\"Args\":[\"${ELECTION_ID}\",\"${CANDIDATE_ID_B}\",\"${NULLIFIER_HASH}\"]}" \
    --transient "{\"votePrivate\":\"${PRIVATE_DATA_B}\"}" \
    --tls \
    --cafile "${ORDERER_CA}" \
    --orderer localhost:7050 \
    --peerAddresses "${EC0_ADDR}"   --tlsRootCertFiles "${EC0_TLS}" \
    --peerAddresses "${PARTY_ADDR}" --tlsRootCertFiles "${PARTY_TLS}" \
    --waitForEvent

  # Nullifier evictCount 확인
  use_ec0
  NULLIFIER_RESULT=$(peer chaincode query \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"GetNullifier\",\"Args\":[\"${NULLIFIER_HASH}\"]}")
  python3 - "${NULLIFIER_HASH}" "${ELECTION_ID}" "${NULLIFIER_RESULT}" <<'PY'
import json
import sys

expected_nullifier, expected_election, raw = sys.argv[1:]
try:
    record = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"final Nullifier query did not return JSON: {exc}: {raw!r}")
if record.get("nullifierHash") != expected_nullifier or record.get("electionID") != expected_election:
    raise SystemExit("final ledger record identity mismatch")
if record.get("evictCount") != 1:
    raise SystemExit(f"revote evictCount must be 1, got {record.get('evictCount')!r}")
PY
  info "  재투표(Eviction) 정상 처리 확인"
  info "  최종 Nullifier 상태: ${NULLIFIER_RESULT}"

  echo ""
  info "모든 테스트 통과!"
}

# ──────────────────────────────────────────────────────────────
# cmd_down / cmd_clean
# ──────────────────────────────────────────────────────────────
cmd_down() {
  info "네트워크 종료 중..."
  cd "$NETWORK_DIR"
  docker compose down --volumes --remove-orphans
  info "종료 완료"
}

cmd_clean() {
  cmd_down
  cd "$NETWORK_DIR"
  rm -rf crypto-config channel-artifacts *.tar.gz
  info "완전 초기화 완료"
}

# ──────────────────────────────────────────────────────────────
# 진입점
# ──────────────────────────────────────────────────────────────
case "${1:-help}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  deploy) cmd_deploy ;;
  test)   cmd_test ;;
  clean)  cmd_clean ;;
  *)
    echo "사용법: $0 {up|deploy|test}"
    echo "        $0 {down|clean} --confirm-destroy-ledger"
    echo ""
    echo "  up     — 인증서 생성 + 제네시스 블록 + Docker 네트워크 실행"
    echo "  down   — 확인 인자 필수; 컨테이너 종료 및 볼륨/원장 삭제"
    echo "  deploy — 체인코드 3개 기관 설치·승인·2-of-3 커밋·최초 InitLedger"
    echo "  test   — 투표 → Nullifier 확인 → 이중투표 차단 smoke test"
    echo "  clean  — 확인 인자 필수; 완전 초기화 (인증서·아티팩트·볼륨/원장 포함)"
    ;;
esac
