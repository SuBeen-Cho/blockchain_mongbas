#!/usr/bin/env bash
# demo-start.sh — 부스 시연 원클릭 기동 (네트워크 확인 → 빌드 → 백엔드 → 헬스)
#
# 사용: cd mongbas && ./scripts/demo-start.sh
#   - 네트워크가 안 떠 있으면 up + deploy 수행
#   - 프론트엔드 빌드 후 백엔드(:3000, .env 자동로드)를 백그라운드 기동
#   - 폰 접속용 공개 터널: 별도 터미널에서 ./scripts/demo-tunnel.sh
set -Eeuo pipefail
cd "$(dirname "$0")/.."   # → mongbas/

echo "[1/4] 네트워크 상태 확인..."
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^voting-chaincode$'; then
  echo "      ✓ 네트워크 실행 중"
else
  echo "      네트워크 미기동 → up + deploy (수 분 소요)"
  (cd network && ./scripts/network.sh up && ./scripts/network.sh deploy)
fi

echo "[2/4] 프론트엔드 빌드..."
(cd frontend && npm run build >/dev/null 2>&1) && echo "      ✓ dist 생성"

echo "[3/4] 백엔드 기동 (:3000, DISABLE_RATE_LIMITS=true)..."
pkill -f "node src/app.js" 2>/dev/null || true
sleep 1
(cd application && DISABLE_RATE_LIMITS=true nohup node src/app.js > /tmp/mongbas-backend.log 2>&1 &)
sleep 4

echo "[4/4] 헬스 체크..."
if curl --fail --silent --show-error --max-time 5 http://localhost:3000/health | node -e '
  const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(health.status === "ok" ? 0 : 1);
' >/dev/null; then
  echo "      ✓ 백엔드 정상"
else
  echo "      ✗ 백엔드 응답 없음 — /tmp/mongbas-backend.log 확인"
  exit 1
fi

cat <<EOF

  ✅ 시연 준비 완료
  ───────────────────────────────────────────────
  관제판(노트북) : http://localhost:3000/?app=control
  검증(내 표 추적): http://localhost:3000/?app=track
  전체 파이프라인 : http://localhost:3000/
  폰 접속 QR      : 다른 터미널에서  ./scripts/demo-tunnel.sh
                   → 출력된 https://*.trycloudflare.com 를 관제판 QR로 사용
  ───────────────────────────────────────────────
EOF
