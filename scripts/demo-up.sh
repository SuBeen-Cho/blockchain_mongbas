#!/usr/bin/env bash
# demo-up.sh — 터미널 창 없이도 계속 도는 부스 데모 (백엔드 + 공개터널 + 블록체인 백그라운드)
#
#   ./scripts/demo-up.sh        ← 한 번 실행하고 터미널 닫아도 계속 실행됨
#   ./scripts/demo-status.sh    ← 상태/공개주소 확인 (언제든)
#   ./scripts/demo-stop.sh      ← 중지
#
# 노트북이 켜져만 있으면 발표 내내 손 안 대도 동작합니다.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source scripts/demo-process-lib.sh
demo_runtime_init
if [ "${MONGBAS_ALLOW_PUBLIC_TUNNEL:-false}" != true ]; then
  echo "[ERROR] demo-up.sh는 Cloudflare quick tunnel로 인터넷 공개를 수행합니다."
  echo "        tailnet QR은 Linux README의 Tailscale Serve 절차를 사용하세요."
  echo "        별도 승인한 경우에만 MONGBAS_ALLOW_PUBLIC_TUNNEL=true로 실행하세요."
  exit 1
fi

echo "[1/5] 블록체인 네트워크 확인..."
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^voting-chaincode$'; then
  echo "      ✓ 실행 중"
else
  echo "      미기동 → up + deploy (수 분 소요)"
  (cd network && ./scripts/network.sh up && ./scripts/network.sh deploy)
fi

echo "[2/5] 컨테이너 자동재시작 정책 (재부팅/크래시 대비)..."
container_names="$(docker ps --format '{{.Names}}' | grep -E 'peer|orderer|couchdb|^ca\.|voting-chaincode')" || {
  echo "      ✗ 재시작 정책을 적용할 투표 컨테이너가 없습니다."
  exit 1
}
printf '%s\n' "${container_names}" | xargs -I{} docker update --restart unless-stopped {} >/dev/null
echo "      ✓ unless-stopped 적용"

echo "[3/5] 프론트엔드 빌드..."
(cd frontend && npm run build >/dev/null 2>&1) && echo "      ✓ dist 생성"

echo "[4/5] 백엔드 백그라운드 기동 (:3000)..."
if curl --fail --silent --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "      ✗ :3000에 이미 백엔드가 실행 중 — 소유권 확인 없이 교체하지 않음"
  exit 1
fi
(cd application && nohup node src/app.js > "${BACKEND_LOG_FILE}" 2>&1 & echo $! > "${BACKEND_PID_FILE}")
sleep 4
if curl --fail --silent --show-error --max-time 5 http://localhost:3000/health | node -e '
  const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.exit(health.status === "ok" ? 0 : 1);
' >/dev/null; then echo "      ✓ 정상"; else echo "      ✗ 백엔드 실패 — ${BACKEND_LOG_FILE} 확인"; exit 1; fi

echo "[5/5] 공개 터널 백그라운드 기동 (간헐적 실패 시 자동 재시도)..."
URL=""
for try in 1 2 3 4; do
  : > "${TUNNEL_LOG_FILE}"
  nohup cloudflared tunnel --url http://localhost:3000 --protocol http2 > "${TUNNEL_LOG_FILE}" 2>&1 &
  tunnel_pid=$!
  printf '%s\n' "${tunnel_pid}" > "${TUNNEL_PID_FILE}"
  for i in $(seq 1 15); do sleep 2; URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_LOG_FILE}" | head -1); [ -n "$URL" ] && break; done
  [ -n "$URL" ] && break
  echo "      터널 시도 $try 실패 → 재시도"
  demo_stop_owned "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" "터널" || exit 1
  sleep 2
done
[ -n "${URL}" ] || { echo "      ✗ 터널 URL 확보 실패 — ${TUNNEL_LOG_FILE} 확인"; exit 1; }
echo "$URL" > "${TUNNEL_URL_FILE}"
echo "      ✓ ${URL}"

cat <<EOF

  ✅ 데모 가동 완료 — 이제 이 터미널을 닫아도 계속 실행됩니다.
  ─────────────────────────────────────────────────────────
  대시보드(이 주소로 여세요) : ${URL}/
  폰 투표 QR : 대시보드에서 [＋ 새 세션] 누르면 자동 표시 (쇼케이스 QR도 자동 동기화)
  ─────────────────────────────────────────────────────────
  상태 확인 : ./scripts/demo-status.sh
  중지       : ./scripts/demo-stop.sh
  ※ 노트북을 재부팅하면 ./scripts/demo-up.sh 만 다시 한 번 실행하세요.
EOF
