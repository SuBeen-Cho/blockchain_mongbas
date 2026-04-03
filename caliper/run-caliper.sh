#!/usr/bin/env bash
# ============================================================
# 팀 몽바스 — Caliper 성능 평가 실행 스크립트
#
# 전제 조건:
#   1. cd ../network && ./scripts/network.sh up
#   2. ./scripts/network.sh deploy
#   3. cd ../caliper && npm install
#   4. npx caliper bind --caliper-bind-sut fabric:2.5
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

# ── HTTP 인증 벤치마크 실행 헬퍼 ──────────────────────────
_http_bench() {
  local label="$1"
  local idemix_enabled="$2"
  local simulate_ms="$3"
  local cache_enabled="${4:-false}"

  local app_dir="${WORKSPACE}/../application"
  local bench_script="${app_dir}/benchmark/http-bench.js"
  local report_json="${REPORT_DIR}/auth_bench_${label}_${TIMESTAMP}.json"

  sep "HTTP 인증 벤치마크: ${label}"
  log "IDEMIX_ENABLED=${idemix_enabled}  IDEMIX_SIMULATE_MS=${simulate_ms}  IDEMIX_CACHE_ENABLED=${cache_enabled}"

  if ! curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    log "⚠️  API 서버 미기동 — 잠시 대기 후 재시도..."
    sleep 3
    if ! curl -sf http://localhost:3000/health >/dev/null 2>&1; then
      log "❌ API 서버 응답 없음. 스킵합니다."
      return
    fi
  fi

  IDEMIX_ENABLED="${idemix_enabled}" \
  IDEMIX_SIMULATE_MS="${simulate_ms}" \
  IDEMIX_CACHE_ENABLED="${cache_enabled}" \
  node "${bench_script}" --duration 15 --concur 20 \
    2>&1 | tee "${REPORT_DIR}/auth_bench_${label}_${TIMESTAMP}.log"

  # 마지막 JSON 리포트를 지정 이름으로 복사
  latest_json=$(ls -t "${app_dir}/benchmark-reports"/auth-bench-*.json 2>/dev/null | head -1)
  if [ -n "${latest_json}" ]; then
    cp "${latest_json}" "${report_json}"
    log "✅ JSON 저장: ${report_json}"
  fi
}

# ── Idemix 성능 비교 (3단계) ───────────────────────────────
_run_idemix_compare() {
  sep "Idemix 성능 비교 — 3단계 측정"
  log "API 서버(node src/app.js)가 실행 중이어야 합니다."
  log "  예: cd ../application && node src/app.js &"
  echo ""

  # 1단계: 기준선 (Idemix 없음)
  _http_bench "1_baseline"  "false" "0"   "false"

  # 2단계: Idemix 적용 (50ms ZKP 시뮬레이션)
  _http_bench "2_idemix"    "true"  "50"  "false"

  # 3단계: Idemix + 캐시 최적화
  _http_bench "3_optimized" "true"  "50"  "true"

  sep "비교 결과 요약"
  log "JSON 리포트:"
  ls -lh "${REPORT_DIR}"/auth_bench_*_${TIMESTAMP}.json 2>/dev/null || true
  echo ""

  # 간단 요약 출력 (jq 있을 경우)
  if command -v jq &>/dev/null; then
    printf "\n%-20s %10s %8s %8s %8s\n" "단계" "TPS" "P50(ms)" "P95(ms)" "P99(ms)"
    printf "%-20s %10s %8s %8s %8s\n" "──────────────────" "──────────" "────────" "────────" "────────"
    for f in "${REPORT_DIR}"/auth_bench_{1_baseline,2_idemix,3_optimized}_${TIMESTAMP}.json; do
      [ -f "$f" ] || continue
      label=$(basename "$f" | sed "s/auth_bench_//;s/_${TIMESTAMP}.json//")
      tps=$(jq -r '.tps'            "$f")
      p50=$(jq -r '.latency.p50Ms'  "$f")
      p95=$(jq -r '.latency.p95Ms'  "$f")
      p99=$(jq -r '.latency.p99Ms'  "$f")
      printf "%-20s %10s %8s %8s %8s\n" "${label}" "${tps}" "${p50}" "${p95}" "${p99}"
    done
    echo ""
  fi
  log "리포트 위치: ${REPORT_DIR}/"
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
    idemix-compare)
      _run_idemix_compare ;;
    *)
      echo "사용법: bash run-caliper.sh [vote|query|all|idemix-compare]"
      exit 1 ;;
  esac

  sep "Caliper 성능 평가 완료"
  log "완료: $(date)"
  log "리포트 위치: ${REPORT_DIR}/"
  ls -lh "${REPORT_DIR}/"*.html 2>/dev/null || true
}

main "$@"
