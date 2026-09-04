#!/usr/bin/env bash
# demo-reset.sh — 네트워크 완전 초기화 + 재기동 (시연 데이터 정리/꼬임 복구용)
#
# 주의: 모든 선거/원장 데이터가 삭제됩니다. 시연일 시작 전 또는 꼬였을 때만 사용.
# 일반적인 "다음 그룹 시작"은 관제판 [새 세션] 버튼으로 충분합니다.
set -e

if [ "$#" -ne 1 ] || [ "$1" != "--confirm-destroy-demo-ledger" ]; then
  echo "REFUSED: this command deletes the demo ledger, volumes and generated cryptographic material" >&2
  echo "usage: ./scripts/demo-reset.sh --confirm-destroy-demo-ledger" >&2
  exit 2
fi

cd "$(dirname "$0")/.."   # → mongbas/
source scripts/demo-process-lib.sh
demo_runtime_init

echo "[1/5] 백엔드 종료..."
demo_stop_owned "${BACKEND_PID_FILE}" "node src/app.js" "${DEMO_REPO_DIR}/application" "백엔드"

echo "[2/5] 네트워크 down (컨테이너 + 볼륨 제거)..."
(cd network && ./scripts/network.sh down --confirm-destroy-ledger) || true

echo "[3/5] crypto-config 정리 (macOS ACL 'deny delete' 제거 포함)..."
# Fabric CA가 root/ACL로 만든 잔여물 때문에 일반 rm이 실패하는 경우 대응
( cd network && chmod -RN crypto-config 2>/dev/null || true; rm -rf crypto-config channel-artifacts )
# 이전 voting-chaincode 컨테이너 이름 충돌 방지
docker rm -f voting-chaincode 2>/dev/null || true

echo "[4/5] 네트워크 up + 체인코드 배포..."
(cd network && ./scripts/network.sh up && ./scripts/network.sh deploy)

echo "[5/5] 완료."
echo "  → 백엔드 기동: ./scripts/demo-start.sh"
