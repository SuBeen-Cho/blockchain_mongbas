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
  local env_vars="$*"
  log "서버 기동: $mode ($env_vars)"
  eval "env $env_vars node src/app.js > /tmp/mongbas-server.log 2>&1 &"
  SERVER_PID=$!
  # 헬스 체크 대기
  local attempts=0
  until curl -s http://localhost:3000/health > /dev/null 2>&1; do
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

# 혹시 남아있는 서버 정리
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  팀 몽바스 — 진짜 Idemix A/B/C 3단계 자동 성능 비교"
echo "  A: bypass / B: PS-BN254(진짜 Idemix CL) / C: BBS+(개선)"
echo "  시작: $(date)"
echo "══════════════════════════════════════════════════════════════"

# ────────────────────────────────────────────────────────────────
# A단계: bypass (인증 없음 — 성능 기준선)
# ────────────────────────────────────────────────────────────────
log "=== A단계 시작: bypass (IDEMIX_ENABLED=false) ==="
start_server "A단계" "IDEMIX_ENABLED=false"

node benchmark/full-comparison-bench.js \
  --out "${REPORTS_DIR}/phase-A-${TIMESTAMP}.json" \
  2>&1 | tee "${REPORTS_DIR}/phase-A-${TIMESTAMP}.log"

stop_server

# ────────────────────────────────────────────────────────────────
# B단계: PS Signatures on BN254 — 진짜 Hyperledger Fabric Idemix
#   - Pointcheval-Sanders 쌍선형 서명 (Fabric Idemix와 동일 수학)
#   - BN254 곡선, 2 pairings per verification (~50-60ms)
# ────────────────────────────────────────────────────────────────
log "=== B단계 시작: PS-BN254 Idemix (IDEMIX_IMPL=ps) ==="
start_server "B단계" "IDEMIX_ENABLED=true IDEMIX_IMPL=ps IDEMIX_CACHE_ENABLED=false"

node benchmark/full-comparison-bench.js \
  --out "${REPORTS_DIR}/phase-B-${TIMESTAMP}.json" \
  2>&1 | tee "${REPORTS_DIR}/phase-B-${TIMESTAMP}.log"

stop_server

# ────────────────────────────────────────────────────────────────
# C단계: BBS+ on BLS12-381 — 개선된 Idemix (논문 기반)
#   - IRTF CFRG BBS 표준, Rust WASM 구현
#   - 선택적 공개 + 완전 비연결성 (매 요청 새 proof)
#   - 예상 성능: ~50ms (createProof + verifyProof)
# ────────────────────────────────────────────────────────────────
log "=== C단계 시작: BBS+-BLS12381 (IDEMIX_IMPL=bbs) ==="
start_server "C단계" "IDEMIX_ENABLED=true IDEMIX_IMPL=bbs IDEMIX_CACHE_ENABLED=false"

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
  2>/dev/null || true

echo "══════════════════════════════════════════════════════════════"
echo "  완료: $(date)"
echo "══════════════════════════════════════════════════════════════"
