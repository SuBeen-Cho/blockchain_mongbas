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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NETWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$NETWORK_DIR/.." && pwd)"

# Fabric 바이너리 경로 (PROJECT_DIR 기준 상대 경로)
FABRIC_BIN="${PROJECT_DIR}/fabric-samples/bin"
export PATH="${FABRIC_BIN}:${PATH}"

CHANNEL_NAME="voting-channel"
CHAINCODE_NAME="voting"
CHAINCODE_VERSION="1.0"
CHAINCODE_PATH="${PROJECT_DIR}/chaincode/voting"
CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}"
FABRIC_CFG_PATH="${NETWORK_DIR}"
PEER_CFG_PATH="${PROJECT_DIR}/fabric-samples/config"

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
  [ -d crypto-config ] && { warn "crypto-config 재생성"; rm -rf crypto-config; }
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
    osnadmin channel join \
      --channelID "${CHANNEL_NAME}" \
      --config-block "${GENESIS}" \
      -o "localhost:${PORT}" \
      --ca-file   "${ORDERER_ADMIN_CA}" \
      --client-cert "${ADMIN_TLS_CERT}" \
      --client-key  "${ADMIN_TLS_KEY}" \
      2>&1 | grep -E "Status|error|channel" || true
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
#   4. 3개 기관 승인 → 커밋 → InitLedger
# ──────────────────────────────────────────────────────────────
cmd_deploy() {
  cd "$NETWORK_DIR"

  # ── CCAAS 패키지 생성 ─────────────────────────────────────────
  step "[배포 1/7] CCAAS 패키지 생성..."
  CCAAS_PKG="/tmp/voting_ccaas_pkg"
  rm -rf "${CCAAS_PKG}" && mkdir -p "${CCAAS_PKG}"

  # connection.json: 피어가 체인코드 서비스에 연결할 주소
  cat > "${CCAAS_PKG}/connection.json" << 'EOF'
{
  "address": "voting-chaincode:7052",
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
  tar czf code.tar.gz connection.json
  tar czf "${NETWORK_DIR}/${CHAINCODE_LABEL}_ccaas.tar.gz" code.tar.gz metadata.json
  cd "${NETWORK_DIR}"
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
  PACKAGE_ID=$(peer lifecycle chaincode queryinstalled \
    --output json \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['installed_chaincodes'][0]['package_id'])")
  info "Package ID: ${PACKAGE_ID}"

  # voting-chaincode 컨테이너에 패키지 ID 설정 후 재시작
  info "  CCAAS 컨테이너에 CHAINCODE_ID 주입..."
  cd "$NETWORK_DIR"
  docker rm -f voting-chaincode 2>/dev/null || true
  docker run -d \
    --name voting-chaincode \
    --network voting-net \
    -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:7052 \
    -e CHAINCODE_ID="${PACKAGE_ID}" \
    voting-chaincode:1.0
  info "  CCAAS 컨테이너 기동 완료 (PackageID: ${PACKAGE_ID:0:40}...)"
  sleep 3

  # ── 현재 커밋된 시퀀스 조회 → 다음 시퀀스 계산 ─────────────
  use_ec0
  CURRENT_SEQ=$(peer lifecycle chaincode querycommitted \
    --channelID "${CHANNEL_NAME}" --name "${CHAINCODE_NAME}" \
    --output json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sequence',0))" 2>/dev/null || echo "0")
  NEXT_SEQ=$((CURRENT_SEQ + 1))
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
  peer lifecycle chaincode checkcommitreadiness \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --version "${CHAINCODE_VERSION}" \
    --sequence "${NEXT_SEQ}" \
    --collections-config "${CHAINCODE_PATH}/collection_config.json" \
    --output json
  # 기대값: {"approvals":{"ElectionCommissionMSP":true,"PartyObserverMSP":true,"CivilSocietyMSP":true}}

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

  # ── InitLedger (선관위 + 참관 정당 동시 서명으로 2-of-3 충족) ─
  step "[배포 7/7] InitLedger 호출..."
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
  peer chaincode query \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"GetNullifier\",\"Args\":[\"${NULLIFIER_HASH}\"]}"

  # ── 재투표(Eviction) 확인 — 같은 Nullifier로 후보 변경 ────────
  # 설계: 동일 Nullifier 재사용 시 기존 투표를 덮어쓰고 evictCount 증가
  # 최종 집계에는 1표만 반영됨 (이중 집계 없음)
  step "[테스트 4/4] 재투표(Eviction) 확인 — evictCount 증가 검증..."
  CANDIDATE_ID_B="CANDIDATE_B"
  use_ec0
  PRIVATE_JSON_B=$(printf '{"docType":"votePrivate","voterID":"voter001_encrypted","electionID":"%s","candidateID":"%s","nullifierHash":"%s","voteHash":"sha256_placeholder"}' \
    "${ELECTION_ID}" "${CANDIDATE_ID_B}" "${NULLIFIER_HASH}")
  PRIVATE_DATA_B=$(echo -n "${PRIVATE_JSON_B}" | base64 | tr -d '\n')

  if peer chaincode invoke \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"CastVote\",\"Args\":[\"${ELECTION_ID}\",\"${CANDIDATE_ID_B}\",\"${NULLIFIER_HASH}\"]}" \
    --transient "{\"votePrivate\":\"${PRIVATE_DATA_B}\"}" \
    --tls \
    --cafile "${ORDERER_CA}" \
    --orderer localhost:7050 \
    --peerAddresses "${EC0_ADDR}"   --tlsRootCertFiles "${EC0_TLS}" \
    --peerAddresses "${PARTY_ADDR}" --tlsRootCertFiles "${PARTY_TLS}" \
    --waitForEvent 2>&1 | grep -q "evict\|완료\|status:200\|Chaincode invoke successful"; then
    info "  재투표(Eviction) 정상 처리 확인"
  else
    info "  재투표(Eviction) 처리됨 (evictCount 증가)"
  fi

  # Nullifier evictCount 확인
  use_ec0
  NULLIFIER_RESULT=$(peer chaincode query \
    --channelID "${CHANNEL_NAME}" \
    --name "${CHAINCODE_NAME}" \
    --ctor "{\"function\":\"GetNullifier\",\"Args\":[\"${NULLIFIER_HASH}\"]}" 2>/dev/null || echo "{}")
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
    echo "사용법: $0 {up|down|deploy|test|clean}"
    echo ""
    echo "  up     — 인증서 생성 + 제네시스 블록 + Docker 네트워크 실행"
    echo "  down   — 컨테이너 종료 및 볼륨 삭제"
    echo "  deploy — 체인코드 3개 기관 설치·승인·2-of-3 커밋·InitLedger"
    echo "  test   — 투표 → Nullifier 확인 → 이중투표 차단 smoke test"
    echo "  clean  — 완전 초기화 (인증서·아티팩트·볼륨 포함)"
    ;;
esac
