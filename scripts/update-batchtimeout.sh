#!/bin/bash
# ============================================================
# scripts/update-batchtimeout.sh — Fabric 채널 BatchTimeout 변경
#
# 사용법: ./scripts/update-batchtimeout.sh <NEW_TIMEOUT>
#   예시: ./scripts/update-batchtimeout.sh 500ms
#         ./scripts/update-batchtimeout.sh 1s
#         ./scripts/update-batchtimeout.sh 2s
#         ./scripts/update-batchtimeout.sh 5s
#
# 전제조건: 네트워크 실행 중 (network.sh up + deploy)
# ============================================================

set -euo pipefail

NEW_TIMEOUT="${1:-2s}"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NETWORK_DIR="${PROJECT_DIR}/network"
FABRIC_BIN="${PROJECT_DIR}/fabric-samples/bin"
PEER_CFG_PATH="${PROJECT_DIR}/fabric-samples/config"
CRYPTO="${NETWORK_DIR}/crypto-config"

export PATH="${FABRIC_BIN}:${PATH}"
export FABRIC_CFG_PATH="${PEER_CFG_PATH}"

CHANNEL_NAME="voting-channel"
ORDERER="localhost:7050"
ORDERER_CA="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/orderers/orderer1.orderer.voting.example.com/tls/ca.crt"

EC_ADMIN_MSP="${CRYPTO}/peerOrganizations/ec.voting.example.com/users/Admin@ec.voting.example.com/msp"
PARTY_ADMIN_MSP="${CRYPTO}/peerOrganizations/party.voting.example.com/users/Admin@party.voting.example.com/msp"
CIVIL_ADMIN_MSP="${CRYPTO}/peerOrganizations/civil.voting.example.com/users/Admin@civil.voting.example.com/msp"
ORDERER_ADMIN_MSP="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/users/Admin@orderer.voting.example.com/msp"

EC_TLS="${CRYPTO}/peerOrganizations/ec.voting.example.com/peers/peer0.ec.voting.example.com/tls/ca.crt"

TMPDIR=$(mktemp -d)
trap "rm -rf ${TMPDIR}" EXIT

echo "============================================================"
echo " BatchTimeout 변경: ${NEW_TIMEOUT}"
echo " 채널: ${CHANNEL_NAME}"
echo " 작업 디렉토리: ${TMPDIR}"
echo "============================================================"

# ── Step 1: EC admin으로 현재 채널 config 블록 가져오기 ──────
echo ""
echo "[1/6] 현재 채널 config 블록 가져오는 중..."
export CORE_PEER_LOCALMSPID="ElectionCommissionMSP"
export CORE_PEER_MSPCONFIGPATH="${EC_ADMIN_MSP}"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ENABLED="true"
export CORE_PEER_TLS_ROOTCERT_FILE="${EC_TLS}"

peer channel fetch config "${TMPDIR}/config_block.pb" \
  -o "${ORDERER}" \
  -c "${CHANNEL_NAME}" \
  --tls --cafile "${ORDERER_CA}" \
  2>&1 | tail -3

echo "  ✅ config 블록 수신 완료"

# ── Step 2: protobuf → JSON 디코드 ────────────────────────
echo ""
echo "[2/6] config 블록 디코드 중..."
configtxlator proto_decode \
  --input "${TMPDIR}/config_block.pb" \
  --type common.Block \
  --output "${TMPDIR}/config_block.json"

# 현재 BatchTimeout 확인
CURRENT_TIMEOUT=$(jq -r '.data.data[0].payload.data.config.channel_group.groups.Orderer.values.BatchTimeout.value.timeout' "${TMPDIR}/config_block.json")
echo "  현재 BatchTimeout: ${CURRENT_TIMEOUT}"
echo "  변경 목표: ${NEW_TIMEOUT}"

# config 부분만 추출
jq '.data.data[0].payload.data.config' "${TMPDIR}/config_block.json" > "${TMPDIR}/config.json"
echo "  ✅ 디코드 완료"

# ── Step 3: BatchTimeout 수정 ─────────────────────────────
echo ""
echo "[3/6] BatchTimeout 수정 중: ${CURRENT_TIMEOUT} → ${NEW_TIMEOUT}"
jq --arg timeout "${NEW_TIMEOUT}" \
  '.channel_group.groups.Orderer.values.BatchTimeout.value.timeout = $timeout' \
  "${TMPDIR}/config.json" > "${TMPDIR}/modified_config.json"

VERIFY_TIMEOUT=$(jq -r '.channel_group.groups.Orderer.values.BatchTimeout.value.timeout' "${TMPDIR}/modified_config.json")
echo "  수정 후 BatchTimeout: ${VERIFY_TIMEOUT}"

if [ "${CURRENT_TIMEOUT}" = "${NEW_TIMEOUT}" ]; then
  echo ""
  echo "  ⚠ 이미 ${NEW_TIMEOUT} — 변경 불필요. 종료."
  exit 0
fi

echo "  ✅ 수정 완료"

# ── Step 4: JSON → protobuf 인코딩 ───────────────────────
echo ""
echo "[4/6] config 인코딩 중..."
configtxlator proto_encode \
  --input "${TMPDIR}/config.json" \
  --type common.Config \
  --output "${TMPDIR}/config.pb"

configtxlator proto_encode \
  --input "${TMPDIR}/modified_config.json" \
  --type common.Config \
  --output "${TMPDIR}/modified_config.pb"

# config update 계산
configtxlator compute_update \
  --channel_id "${CHANNEL_NAME}" \
  --original "${TMPDIR}/config.pb" \
  --updated "${TMPDIR}/modified_config.pb" \
  --output "${TMPDIR}/config_update.pb"

# update envelope으로 감싸기
configtxlator proto_decode \
  --input "${TMPDIR}/config_update.pb" \
  --type common.ConfigUpdate \
  --output "${TMPDIR}/config_update_decoded.json"

jq -s '.[0] as $update | {"payload":{"header":{"channel_header":{"channel_id":"'"${CHANNEL_NAME}"'","type":2}},"data":{"config_update":$update}}}' \
  "${TMPDIR}/config_update_decoded.json" \
  > "${TMPDIR}/config_update_envelope.json"

configtxlator proto_encode \
  --input "${TMPDIR}/config_update_envelope.json" \
  --type common.Envelope \
  --output "${TMPDIR}/config_update_in_envelope.pb"

echo "  ✅ 인코딩 완료"

# ── Step 5: Orderer Admin + 3개 피어 조직 서명 ──────────
echo ""
echo "[5/6] Orderer Admin + 3개 조직 서명 중..."

# Orderer Admin 서명 (BatchTimeout은 Orderer 그룹 → Orderer Admin 정책 필요)
ORDERER_TLS="${CRYPTO}/ordererOrganizations/orderer.voting.example.com/orderers/orderer1.orderer.voting.example.com/tls/ca.crt"
export CORE_PEER_LOCALMSPID="OrdererMSP"
export CORE_PEER_MSPCONFIGPATH="${ORDERER_ADMIN_MSP}"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${EC_TLS}"
peer channel signconfigtx -f "${TMPDIR}/config_update_in_envelope.pb" 2>&1 | tail -2
echo "  ✅ Orderer Admin 서명 완료"

# EC 서명
export CORE_PEER_LOCALMSPID="ElectionCommissionMSP"
export CORE_PEER_MSPCONFIGPATH="${EC_ADMIN_MSP}"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${EC_TLS}"
peer channel signconfigtx -f "${TMPDIR}/config_update_in_envelope.pb" 2>&1 | tail -2
echo "  ✅ EC 서명 완료"

# Party 서명
PARTY_TLS="${CRYPTO}/peerOrganizations/party.voting.example.com/peers/peer0.party.voting.example.com/tls/ca.crt"
export CORE_PEER_LOCALMSPID="PartyObserverMSP"
export CORE_PEER_MSPCONFIGPATH="${PARTY_ADMIN_MSP}"
export CORE_PEER_ADDRESS="localhost:8051"
export CORE_PEER_TLS_ROOTCERT_FILE="${PARTY_TLS}"
peer channel signconfigtx -f "${TMPDIR}/config_update_in_envelope.pb" 2>&1 | tail -2
echo "  ✅ Party 서명 완료"

# Civil 서명
CIVIL_TLS="${CRYPTO}/peerOrganizations/civil.voting.example.com/peers/peer0.civil.voting.example.com/tls/ca.crt"
export CORE_PEER_LOCALMSPID="CivilSocietyMSP"
export CORE_PEER_MSPCONFIGPATH="${CIVIL_ADMIN_MSP}"
export CORE_PEER_ADDRESS="localhost:9051"
export CORE_PEER_TLS_ROOTCERT_FILE="${CIVIL_TLS}"
peer channel signconfigtx -f "${TMPDIR}/config_update_in_envelope.pb" 2>&1 | tail -2
echo "  ✅ Civil 서명 완료"

# ── Step 6: 채널 config 업데이트 제출 ───────────────────
echo ""
echo "[6/6] 채널 config 업데이트 제출 중..."
export CORE_PEER_LOCALMSPID="ElectionCommissionMSP"
export CORE_PEER_MSPCONFIGPATH="${EC_ADMIN_MSP}"
export CORE_PEER_ADDRESS="localhost:7051"
export CORE_PEER_TLS_ROOTCERT_FILE="${EC_TLS}"

peer channel update \
  -f "${TMPDIR}/config_update_in_envelope.pb" \
  -c "${CHANNEL_NAME}" \
  -o "${ORDERER}" \
  --tls --cafile "${ORDERER_CA}" \
  2>&1 | tail -3

echo ""
echo "============================================================"
echo " ✅ BatchTimeout 변경 완료: ${CURRENT_TIMEOUT} → ${NEW_TIMEOUT}"
echo " 채널: ${CHANNEL_NAME}"
echo "============================================================"
echo ""
echo "  적용 확인하려면:"
echo "  peer channel fetch config /tmp/verify.pb -o ${ORDERER} -c ${CHANNEL_NAME} --tls --cafile ${ORDERER_CA}"
echo "  configtxlator proto_decode --input /tmp/verify.pb --type common.Block | jq '.data.data[0].payload.data.config.channel_group.groups.Orderer.values.BatchTimeout'"
