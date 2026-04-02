#!/usr/bin/env bash
# ============================================================
# 팀 몽바스 — Caliper 성능 평가 실행 스크립트
#
# 전제 조건:
#   1. cd ../network && ./scripts/network.sh up
#   2. ./scripts/network.sh deploy
#   3. cd ../caliper && npm install
#   4. npx caliper bind --caliper-bind-sut fabric:2.4
#
# 실행:
#   bash run-caliper.sh [vote|query|all]
#   기본값: all
# ============================================================
set -euo pipefail

BENCH="${1:-all}"
WORKSPACE="$(cd "$(dirname "$0")" && pwd)"
REPORT_DIR="${WORKSPACE}/reports"
mkdir -p "${REPORT_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
sep()  { echo ""; echo "══════════════════════════════════════════════════════"; echo "  $*"; echo "══════════════════════════════════════════════════════"; }

# ── 전제 조건 확인 ─────────────────────────────────────────
check_prereqs() {
  log "전제 조건 확인..."

  if ! docker ps | grep -q "peer0.ec.voting.example.com"; then
    echo "❌ Fabric 네트워크가 기동되지 않았습니다."
    echo "   → cd ../network && ./scripts/network.sh up && ./scripts/network.sh deploy"
    exit 1
  fi

  if ! curl -sf http://localhost:3000/health | grep -q "ok" 2>/dev/null; then
    log "⚠️  API 서버가 응답하지 않습니다. Caliper는 직접 Fabric SDK로 연결합니다."
  fi

  if [ ! -d "${WORKSPACE}/node_modules/@hyperledger/caliper-core" ]; then
    echo "❌ Caliper가 설치되지 않았습니다."
    echo "   → cd caliper && npm install && npx caliper bind --caliper-bind-sut fabric:2.4"
    exit 1
  fi

  log "✅ 전제 조건 OK"
}

# ── 벤치마크 실행 ──────────────────────────────────────────
run_bench() {
  local bench_config="$1"
  local label="$2"
  local report_file="${REPORT_DIR}/caliper_${label}_${TIMESTAMP}.html"

  sep "Caliper 벤치마크: ${label}"
  log "설정: ${bench_config}"
  log "리포트: ${report_file}"

  npx caliper launch manager \
    --caliper-workspace      "${WORKSPACE}" \
    --caliper-networkconfig  networks/fabric-network.yaml \
    --caliper-benchconfig    "benchmarks/${bench_config}" \
    --caliper-flow-only-test \
    --caliper-report-path    "${report_file}" \
    2>&1 | tee "${REPORT_DIR}/caliper_${label}_${TIMESTAMP}.log"

  log "✅ ${label} 완료 → ${report_file}"
}

# ── 메인 ──────────────────────────────────────────────────
main() {
  sep "팀 몽바스 — Caliper 성능 평가 시작"
  log "모드: ${BENCH} | 시작: $(date)"

  check_prereqs

  case "${BENCH}" in
    vote)
      run_bench cast-vote.yaml "CastVote" ;;
    query)
      run_bench get-election.yaml "QueryOnly" ;;
    all)
      run_bench cast-vote.yaml    "CastVote"
      run_bench get-election.yaml "QueryOnly"
      run_bench full-bench.yaml   "FullBench"
      ;;
    *)
      echo "사용법: bash run-caliper.sh [vote|query|all]"
      exit 1 ;;
  esac

  sep "Caliper 성능 평가 완료"
  log "완료: $(date)"
  log "리포트 위치: ${REPORT_DIR}/"
  ls -lh "${REPORT_DIR}/"*.html 2>/dev/null || true
}

main "$@"
