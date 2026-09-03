#!/usr/bin/env bash
# demo-status.sh — 부스 데모 상태 + 공개 주소 확인 (언제든)
set -u
cd "$(dirname "$0")/.."
source scripts/demo-process-lib.sh
demo_runtime_init
TURL=$(cat "${TUNNEL_URL_FILE}" 2>/dev/null)
echo "──────── Mongbas 데모 상태 ────────"
demo_owned_pid "${BACKEND_PID_FILE}" "node src/app.js" "${DEMO_REPO_DIR}/application" >/dev/null && echo "백엔드   : ● 이 작업공간이 기동" || echo "백엔드   : ○ 소유 PID 없음"
curl --fail --silent --show-error --max-time 4 http://localhost:3000/health | node -e '
  const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(health.status === "ok" ? 0 : 1);
' >/dev/null 2>&1 && echo "헬스     : ● 정상 (:3000)" || echo "헬스     : ○ 비정상/응답 없음"
demo_owned_pid "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" >/dev/null && echo "공개터널 : ● 이 작업공간이 기동" || echo "공개터널 : ○ 소유 PID 없음"
echo "───────────────────────────────────"
if [ -n "$TURL" ]; then
  echo "대시보드 : $TURL/"
  echo "(폰 QR은 대시보드 [새 세션] 시 자동)"
else
  echo "공개주소 : (없음 — ./scripts/demo-up.sh 먼저 실행)"
fi
echo "───────────────────────────────────"
echo "블록체인 컨테이너:"
docker ps --format '  {{.Names}}  {{.Status}}' 2>/dev/null | grep -E 'peer|orderer|couchdb|voting-chaincode' | head -8 || echo "  (Docker 미실행)"
