#!/usr/bin/env bash
#
# ElGamal E2E 벤치마크 — 3개 시나리오 자동 실행
#
# 사용법:
#   cd mongbas/application
#   bash benchmark/run-elgamal-bench.sh [--n 100] [--warmup 10]
#
# 사전 조건:
#   1. Fabric 네트워크 기동 + 체인코드 배포 완료
#   2. API 서버 기동 (npm start)
#   3. 각 시나리오 실행 전 서버를 해당 IDEMIX_IMPL로 재기동
#
# 참고: 이 스크립트는 서버를 자동 재기동하지 않음.
#       각 시나리오별로 수동 재기동 필요.

set -euo pipefail
cd "$(dirname "$0")/.."

N="${1:-100}"
WARMUP="${2:-10}"
URL="${3:-http://localhost:3000}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_DIR="benchmark-reports"

echo "═══════════════════════════════════════════════════"
echo " ElGamal E2E Benchmark Runner"
echo " N=${N}, WARMUP=${WARMUP}, URL=${URL}"
echo " TIMESTAMP=${TIMESTAMP}"
echo "═══════════════════════════════════════════════════"

# 서버 상태 확인
check_server() {
  local health
  health=$(curl -s "${URL}/health" 2>/dev/null) || { echo "[ERROR] 서버에 연결할 수 없습니다: ${URL}"; exit 1; }
  echo "$health" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const i = d.idemix || {};
    console.log('  서버 상태: OK');
    console.log('  인증 모드: enabled=' + i.enabled + ' impl=' + (i.idemixImpl || i.impl || 'N/A'));
  "
}

run_scenario() {
  local label="$1"
  local out="${REPORT_DIR}/elgamal-${label}-${TIMESTAMP}.json"

  echo ""
  echo "──────────────────────────────────────────────────"
  echo " 시나리오: ${label}"
  echo "──────────────────────────────────────────────────"

  check_server

  echo "  실행 중..."
  node benchmark/elgamal-e2e-bench.js \
    --url "${URL}" \
    --n "${N}" \
    --warmup "${WARMUP}" \
    --out "${out}"

  echo "  결과: ${out}"
}

echo ""
echo "[INFO] 현재 서버 상태 확인..."
check_server

echo ""
echo "═══════════════════════════════════════════════════"
echo " 시나리오 실행 안내"
echo "═══════════════════════════════════════════════════"
echo ""
echo " 각 시나리오별로 서버 환경변수를 변경하고 재기동해야 합니다:"
echo ""
echo " S1 (Ed25519):  IDEMIX_ENABLED=true IDEMIX_IMPL=ed25519 npm start"
echo " S2 (PS-BN254): IDEMIX_ENABLED=true IDEMIX_IMPL=ps npm start"
echo " S3 (BBS+):     IDEMIX_ENABLED=true IDEMIX_IMPL=bbs npm start"
echo ""
echo " 현재 서버 설정으로 벤치마크를 실행합니다."
echo " (Ctrl+C로 취소 가능)"
echo ""

# 현재 서버 설정 감지 후 해당 시나리오 실행
IMPL=$(curl -s "${URL}/health" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const i = d.idemix || {};
  if (!i.enabled) console.log('bypass');
  else if (i.idemixImpl === 'ps') console.log('ps');
  else if (i.idemixImpl === 'bbs') console.log('bbs');
  else console.log('ed25519');
" 2>/dev/null)

case "${IMPL}" in
  ps)       run_scenario "S2-PS-BN254" ;;
  bbs)      run_scenario "S3-BBS" ;;
  ed25519)  run_scenario "S1-Ed25519" ;;
  bypass)   run_scenario "S0-bypass" ;;
  *)        run_scenario "unknown-${IMPL}" ;;
esac

echo ""
echo "═══════════════════════════════════════════════════"
echo " 완료"
echo "═══════════════════════════════════════════════════"
echo ""
echo " 다른 시나리오를 실행하려면 서버를 재기동 후 다시 실행하세요."
echo " 예: IDEMIX_IMPL=ps npm start && bash benchmark/run-elgamal-bench.sh"
