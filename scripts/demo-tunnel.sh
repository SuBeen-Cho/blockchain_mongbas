#!/usr/bin/env bash
# demo-tunnel.sh — 부스 시연용 공개 터널 (cloudflared, 무료)
#
# 백엔드(:3000, 정적 프론트엔드 포함)를 공개 https URL로 노출한다.
# 출력되는 https://xxxx.trycloudflare.com 주소를 QR로 만들어 관객 폰에 배포.
#   - 폰 투표:   https://xxxx.trycloudflare.com/?app=kiosk&e=<electionID>
#   - 관제판:    https://xxxx.trycloudflare.com/?app=control  (부스 노트북)
#
# 사전: 백엔드가 :3000에서 실행 중이어야 함
#   cd application && DISABLE_RATE_LIMITS=true npm start
#
# cloudflared 미설치 시: brew install cloudflared
#
# 대안(터널 없이 같은 WiFi): 노트북 IP로 접속
#   CORS_ORIGIN 에 http://<노트북IP>:3000 추가 후 http://<노트북IP>:3000/?app=kiosk&e=...

set -e

PORT="${1:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[ERROR] cloudflared 가 설치되어 있지 않습니다."
  echo "        설치: brew install cloudflared"
  echo "        (대안) ngrok http ${PORT}  — 단, 무료는 첫 방문 경고 페이지 있음"
  exit 1
fi

echo "[INFO] cloudflared 터널 시작 → http://localhost:${PORT}"
echo "[INFO] 출력되는 https://*.trycloudflare.com 주소를 QR로 배포하세요."
exec cloudflared tunnel --url "http://localhost:${PORT}"
