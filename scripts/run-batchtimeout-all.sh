#!/bin/bash
# ============================================================
# scripts/run-batchtimeout-all.sh — BatchTimeout 전체 측정 자동화
#
# BatchTimeout: 500ms / 1s / 2s / 5s 순서로 변경하면서 각각 TPS 측정
# 전제조건: 네트워크 실행 중 (network.sh up + deploy + API 서버 실행)
#
# 실행: cd mongbas && bash scripts/run-batchtimeout-all.sh
# 출력: docs/security-eval/extended/bt-results/*.json
#       docs/security-eval/extended/BATCHTIMEOUT-RESULTS.md
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "============================================================"
echo " BatchTimeout 전체 벤치마크 시작"
echo " 대상: 500ms / 1s / 2s / 5s × TPS 1/3/5/10/20"
echo "============================================================"

TIMEOUTS=("500ms" "1s" "2s" "5s")

for BT in "${TIMEOUTS[@]}"; do
  echo ""
  echo "──────────────────────────────────────────────────────────"
  echo " BatchTimeout → ${BT} 으로 변경"
  echo "──────────────────────────────────────────────────────────"

  bash "${SCRIPT_DIR}/update-batchtimeout.sh" "${BT}"

  echo ""
  echo " 채널 config 적용 대기 (5초)..."
  sleep 5

  echo " TPS 벤치마크 실행: BatchTimeout=${BT}"
  node "${SCRIPT_DIR}/batchtimeout-bench.js" "${BT}"

  echo " 다음 BT 변경 전 쿨다운 (3초)..."
  sleep 3
done

# 2s로 원복
echo ""
echo "──────────────────────────────────────────────────────────"
echo " BatchTimeout 원복: 2s (기본값)"
echo "──────────────────────────────────────────────────────────"
bash "${SCRIPT_DIR}/update-batchtimeout.sh" "2s"

echo ""
echo "──────────────────────────────────────────────────────────"
echo " 마크다운 리포트 생성 중..."
echo "──────────────────────────────────────────────────────────"
node "${SCRIPT_DIR}/generate-bt-report.js"

echo ""
echo "============================================================"
echo " ✅ 전체 BatchTimeout 벤치마크 완료"
echo " 결과: docs/security-eval/extended/BATCHTIMEOUT-RESULTS.md"
echo "============================================================"
