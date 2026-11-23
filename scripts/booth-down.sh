#!/usr/bin/env bash
# booth-down.sh — booth-up.sh가 띄운 백엔드·터널·잠자기 방지만 종료 (Fabric 원장은 그대로)
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source scripts/demo-process-lib.sh
demo_runtime_init
echo "부스 종료 진행"
demo_stop_owned "${BACKEND_PID_FILE}" "node src/app.js" "${DEMO_REPO_DIR}/application" "백엔드" || true
demo_stop_owned "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" "공개 터널" || true
CAFFEINATE_PID_FILE="${DEMO_RUNTIME_DIR}/caffeinate.pid"
if [ -f "${CAFFEINATE_PID_FILE}" ]; then
  kill "$(cat "${CAFFEINATE_PID_FILE}")" 2>/dev/null && echo "  ✓ 잠자기 방지 해제" || true
  rm -f "${CAFFEINATE_PID_FILE}"
fi
echo "Fabric 컨테이너와 원장은 그대로 둠 (docker ps로 확인)"
