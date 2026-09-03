#!/usr/bin/env bash
# demo-start.sh — 부스 시연 원클릭 기동 (네트워크 확인 → 빌드 → 백엔드 → 헬스)
#
# 사용: cd mongbas && ./scripts/demo-start.sh
#   - 네트워크가 안 떠 있으면 up + deploy 수행
#   - 프론트엔드 빌드 후 백엔드(:3000, .env 자동로드)를 백그라운드 기동
#   - 폰 접속은 승인된 tailnet 전용 Tailscale Serve HTTPS를 사용
set -Eeuo pipefail
cd "$(dirname "$0")/.."   # → mongbas/
source scripts/demo-process-lib.sh
demo_runtime_init

echo "[1/4] 네트워크 상태 확인..."
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^voting-chaincode$'; then
  echo "      ✓ 네트워크 실행 중"
else
  echo "      네트워크 미기동 → up + deploy (수 분 소요)"
  (cd network && ./scripts/network.sh up && ./scripts/network.sh deploy)
fi

echo "[2/4] 프론트엔드 빌드..."
(cd frontend && npm run build >/dev/null 2>&1) && echo "      ✓ dist 생성"

echo "[3/4] 백엔드 기동 (:3000, rate limits enabled)..."
if curl --fail --silent --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "      ✗ :3000에 이미 백엔드가 실행 중 — 소유권 확인 없이 교체하지 않음"
  exit 1
fi
(cd application && nohup node src/app.js > "${BACKEND_LOG_FILE}" 2>&1 & echo $! > "${BACKEND_PID_FILE}")
sleep 4

echo "[4/4] 헬스 체크..."
if curl --fail --silent --show-error --max-time 5 http://localhost:3000/health | node -e '
  const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(health.status === "ok" ? 0 : 1);
' >/dev/null; then
  echo "      ✓ 백엔드 정상"
else
  echo "      ✗ 백엔드 응답 없음 — ${BACKEND_LOG_FILE} 확인"
  exit 1
fi

cat <<EOF

  ✅ 시연 준비 완료
  ───────────────────────────────────────────────
  관제판(노트북) : http://localhost:3000/?app=control
  검증(내 표 추적): http://localhost:3000/?app=track
  전체 파이프라인 : http://localhost:3000/
  폰 접속 QR      : deploy/linux/README.md의 Tailscale Serve HTTPS 절차
                   → 인터넷 Funnel/Quick Tunnel은 별도 승인 없이 사용 금지
  ───────────────────────────────────────────────
EOF
