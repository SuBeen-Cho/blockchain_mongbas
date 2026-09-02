#!/usr/bin/env bash
# demo-status.sh — 부스 데모 상태 + 공개 주소 확인 (언제든)
set -u
cd "$(dirname "$0")/.."
TURL=$(cat /tmp/mongbas-tunnel-url.txt 2>/dev/null)
echo "──────── Mongbas 데모 상태 ────────"
pgrep -f "node src/app.js" >/dev/null && echo "백엔드   : ● 실행 중" || echo "백엔드   : ○ 꺼짐"
curl --fail --silent --show-error --max-time 4 http://localhost:3000/health | node -e '
  const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(health.status === "ok" ? 0 : 1);
' >/dev/null 2>&1 && echo "헬스     : ● 정상 (:3000)" || echo "헬스     : ○ 비정상/응답 없음"
pgrep -f "cloudflared tunnel" >/dev/null && echo "공개터널 : ● 실행 중" || echo "공개터널 : ○ 꺼짐"
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
