#!/usr/bin/env bash
# benchmark/run-comparison.sh
# A/B/C 3단계 서버를 순서대로 기동→측정→종료하는 오케스트레이션 스크립트

set -euo pipefail
cd "$(dirname "$0")/.."

REPORTS_DIR="benchmark-reports"
mkdir -p "$REPORTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# 색상
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date +%H:%M:%S)] $*${NC}"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] $*${NC}"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)] $*${NC}"; }

# 서버 기동 함수
start_server() {
  local mode=$1; shift
  local expected_health_mode expected_health_impl
  case "${mode}" in
    A단계) expected_health_mode=bypass; expected_health_impl=HMAC-SHA256 ;;
    B단계) expected_health_mode=idemix-ps; expected_health_impl='PS-BN254 credential prototype' ;;
    C단계) expected_health_mode=idemix-bbs; expected_health_impl='BBS+-BLS12381 (C단계: 개선 Idemix)' ;;
    *) err "알 수 없는 측정 모드: ${mode}"; exit 1 ;;
  esac
  log "서버 기동: $mode ($*)"
  env NODE_ENV=development ENABLE_BENCH_ENDPOINTS=true ENABLE_DEMO_CREDENTIALS=true \
    DISABLE_RATE_LIMITS=true SESSION_SECRET=bench-session-secret \
    CREDENTIAL_SECRET=bench-credential-secret "$@" \
    node src/app.js > /tmp/mongbas-server.log 2>&1 &
  SERVER_PID=$!
  # 헬스 체크 대기
  local attempts=0
  until curl --fail --silent --show-error http://localhost:3000/health | \
    EXPECTED_HEALTH_MODE="${expected_health_mode}" EXPECTED_HEALTH_IMPL="${expected_health_impl}" node -e '
    const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.exit(health.status === "ok" && health.idemix?.mode === process.env.EXPECTED_HEALTH_MODE &&
      health.idemix?.impl === process.env.EXPECTED_HEALTH_IMPL &&
      health.benchmark?.authEndpointEnabled === true &&
      health.benchmark?.rateLimitsDisabled === true &&
      health.benchmark?.demoCredentialsEnabled === true ? 0 : 1);
  ' >/dev/null 2>&1; do
    sleep 0.5
    attempts=$((attempts + 1))
    if [ $attempts -ge 30 ]; then
      err "서버 기동 실패 (15초 초과)"
      cat /tmp/mongbas-server.log
      exit 1
    fi
  done
  log "서버 준비 완료 (PID=$SERVER_PID)"
}

trap stop_server EXIT INT TERM

# 서버 종료 함수
stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    log "서버 종료 (PID=$SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    sleep 1
  fi
}

if lsof -ti:3000 >/dev/null 2>&1; then
  err "TCP 3000 포트를 이미 사용 중입니다. 기존 프로세스를 임의로 종료하지 않습니다."
  exit 1
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  팀 몽바스 — credential 프로토타입 A/B/C 자동 성능 비교"
echo "  A: bypass / B: PS-BN254 prototype / C: BBS+ prototype"
echo "  시작: $(date)"
echo "══════════════════════════════════════════════════════════════"

# ────────────────────────────────────────────────────────────────
# A단계: bypass (인증 없음 — 성능 기준선)
# ────────────────────────────────────────────────────────────────
log "=== A단계 시작: bypass (IDEMIX_ENABLED=false) ==="
start_server "A단계" IDEMIX_ENABLED=false

node benchmark/full-comparison-bench.js \
  --out "${REPORTS_DIR}/phase-A-${TIMESTAMP}.json" \
  2>&1 | tee "${REPORTS_DIR}/phase-A-${TIMESTAMP}.log"

stop_server

# ────────────────────────────────────────────────────────────────
# B단계: PS Signatures on BN254 독립 credential 프로토타입
#   - Fabric Idemix 호환성을 주장하지 않는 비교용 구현
#   - BN254 곡선, 2 pairings per verification (~50-60ms)
# ────────────────────────────────────────────────────────────────
log "=== B단계 시작: PS-BN254 Idemix (IDEMIX_IMPL=ps) ==="
start_server "B단계" IDEMIX_ENABLED=true IDEMIX_IMPL=ps IDEMIX_CACHE_ENABLED=false

node benchmark/full-comparison-bench.js \
  --out "${REPORTS_DIR}/phase-B-${TIMESTAMP}.json" \
  2>&1 | tee "${REPORTS_DIR}/phase-B-${TIMESTAMP}.log"

stop_server

# ────────────────────────────────────────────────────────────────
# C단계: BBS+ on BLS12-381 credential prototype
#   - 현재 구현의 실측치만 비교하며 보안 속성은 이 벤치마크로 입증하지 않음
# ────────────────────────────────────────────────────────────────
log "=== C단계 시작: BBS+-BLS12381 (IDEMIX_IMPL=bbs) ==="
start_server "C단계" IDEMIX_ENABLED=true IDEMIX_IMPL=bbs IDEMIX_CACHE_ENABLED=false

node benchmark/full-comparison-bench.js \
  --out "${REPORTS_DIR}/phase-C-${TIMESTAMP}.json" \
  2>&1 | tee "${REPORTS_DIR}/phase-C-${TIMESTAMP}.log"

stop_server

log "=== 전체 측정 완료 ==="
echo ""
echo "결과 파일:"
ls -lh "${REPORTS_DIR}/"*"${TIMESTAMP}"* 2>/dev/null
echo ""
echo "보고서 생성 중..."
node benchmark/generate-report.js \
  "${REPORTS_DIR}/phase-A-${TIMESTAMP}.json" \
  "${REPORTS_DIR}/phase-B-${TIMESTAMP}.json" \
  "${REPORTS_DIR}/phase-C-${TIMESTAMP}.json" \
  --out "${REPORTS_DIR}/comparison-${TIMESTAMP}.json" \
  2>"${REPORTS_DIR}/comparison-${TIMESTAMP}.stderr.log"
[ -s "${REPORTS_DIR}/comparison-${TIMESTAMP}.json" ] || {
  err "종합 비교 보고서가 생성되지 않았습니다."
  exit 1
}

echo "══════════════════════════════════════════════════════════════"
echo "  완료: $(date)"
echo "══════════════════════════════════════════════════════════════"
