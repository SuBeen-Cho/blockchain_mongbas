#!/usr/bin/env bash
# demo-stop.sh — 이 작업공간이 기동한 백엔드 + 터널만 중지
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source scripts/demo-process-lib.sh
demo_runtime_init
echo "백엔드/터널 중지..."
demo_stop_owned "${BACKEND_PID_FILE}" "node src/app.js" "${DEMO_REPO_DIR}/application" "백엔드"
demo_stop_owned "${TUNNEL_PID_FILE}" "cloudflared tunnel" "${DEMO_REPO_DIR}" "공개터널"
echo "블록체인 네트워크는 그대로 둡니다."
echo "(원장·볼륨까지 삭제하려면 별도 승인 후: cd network && ./scripts/network.sh down --confirm-destroy-ledger)"
