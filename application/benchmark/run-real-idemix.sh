#!/usr/bin/env bash
# benchmark/run-real-idemix.sh
# 진짜 Idemix 3단계 자동 성능 비교 오케스트레이션
#
# A단계: bypass (기준선)
# B단계: PS-BN254 (Hyperledger Fabric Idemix와 동일 수학)
# C단계: BBS+-BLS12381 (IRTF CFRG 표준, 개선된 Idemix)

set -euo pipefail
cd "$(dirname "$0")/.."

REPORTS_DIR="benchmark-reports"
mkdir -p "$REPORTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date +%H:%M:%S)] $*${NC}"; }
info() { echo -e "${CYAN}[$(date +%H:%M:%S)] $*${NC}"; }
warn() { echo -e "${YELLOW}[$(date +%H:%M:%S)] $*${NC}"; }
err()  { echo -e "${RED}[$(date +%H:%M:%S)] $*${NC}"; }

start_server() {
  local mode=$1; shift
  local env_vars="$*"
  log "서버 기동: $mode"
  info "  env: $env_vars"
  eval "env $env_vars node src/app.js > /tmp/mongbas-server.log 2>&1 &"
  SERVER_PID=$!
  local attempts=0
  until curl -s http://localhost:3000/health > /dev/null 2>&1; do
    sleep 0.5
    attempts=$((attempts + 1))
    if [ $attempts -ge 40 ]; then
      err "서버 기동 실패 (20초 초과)"
      cat /tmp/mongbas-server.log
      exit 1
    fi
  done
  log "서버 준비 완료 (PID=$SERVER_PID)"
  # 헬스 체크 출력
  curl -s http://localhost:3000/health | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('  mode:', d.idemix.mode, '| impl:', d.idemix.impl);
  " 2>/dev/null || true
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    log "서버 종료 (PID=$SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    sleep 1
  fi
}

# 기존 서버 정리
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  팀 몽바스 — 진짜 Idemix A/B/C 3단계 성능 비교                  ║"
echo "║  A: bypass  │  B: PS-BN254(진짜 Idemix)  │  C: BBS+(개선)        ║"
echo "║  시작: $(date +'%Y-%m-%d %H:%M:%S')                                  ║"
echo "╚══════════════════════════════════════════════════════════════════╝"

# ════════════════════════════════════════════════════════════════
# A단계: bypass (인증 없음 — 성능 기준선)
# ════════════════════════════════════════════════════════════════
echo ""
log "========== A단계: bypass =========="
start_server "A단계" "IDEMIX_ENABLED=false"

node benchmark/real-idemix-bench.js \
  --out "${REPORTS_DIR}/real-A-${TIMESTAMP}.json" \
  --sec 8 \
  2>&1 | tee "${REPORTS_DIR}/real-A-${TIMESTAMP}.log"

stop_server

# ════════════════════════════════════════════════════════════════
# B단계: PS-BN254 — 진짜 Hyperledger Fabric Idemix
#
#   수학적 등가성:
#   - Hyperledger Fabric Idemix는 amcl 라이브러리의 BN256 곡선 사용
#   - BN256 = BN254 (254-bit prime, 동일 곡선)
#   - Pointcheval-Sanders 서명 방정식 동일: e(h, X·∏Yi^mi) == e(σ, g2)
#   - pure JavaScript 구현 (@noble/curves)
# ════════════════════════════════════════════════════════════════
echo ""
log "========== B단계: PS-BN254 (진짜 Idemix) =========="
start_server "B단계" "IDEMIX_ENABLED=true IDEMIX_IMPL=ps IDEMIX_CACHE_ENABLED=false"

node benchmark/real-idemix-bench.js \
  --out "${REPORTS_DIR}/real-B-${TIMESTAMP}.json" \
  --sec 8 \
  2>&1 | tee "${REPORTS_DIR}/real-B-${TIMESTAMP}.log"

stop_server

# ════════════════════════════════════════════════════════════════
# C단계: BBS+-BLS12381 — 개선된 Idemix (논문 기반)
#
#   개선 근거:
#   - IRTF CFRG draft-irtf-cfrg-bbs-signatures (Boneh et al.)
#   - BLS12-381 곡선 (128-bit 보안, BN254와 동등)
#   - Rust WASM 구현 → JS 대비 4-8x 빠른 실행
#   - 속성 수 무관 O(1) 검증 (BN254는 O(k))
#   - 완전 비연결성: 매 요청 fresh nonce ZKP proof
#   - 선택적 공개: voterEligible만 공개, electionID 숨김
# ════════════════════════════════════════════════════════════════
echo ""
log "========== C단계: BBS+-BLS12381 (개선 Idemix) =========="
start_server "C단계" "IDEMIX_ENABLED=true IDEMIX_IMPL=bbs IDEMIX_CACHE_ENABLED=false"

node benchmark/real-idemix-bench.js \
  --out "${REPORTS_DIR}/real-C-${TIMESTAMP}.json" \
  --sec 8 \
  2>&1 | tee "${REPORTS_DIR}/real-C-${TIMESTAMP}.log"

stop_server

# ════════════════════════════════════════════════════════════════
# 종합 비교 출력
# ════════════════════════════════════════════════════════════════
log "=== 전체 측정 완료 ==="
echo ""
echo "결과 파일:"
ls -lh "${REPORTS_DIR}/real-"*"-${TIMESTAMP}"* 2>/dev/null

echo ""
echo "─── 3단계 종합 비교 ───"
node -e "
const fs = require('fs');
const ts = '${TIMESTAMP}';
const dir = '${REPORTS_DIR}';

function load(phase) {
  try { return JSON.parse(fs.readFileSync(\`\${dir}/real-\${phase}-\${ts}.json\`, 'utf8')); }
  catch { return null; }
}

const A = load('A'), B = load('B'), C = load('C');
const phases = [A, B, C].filter(Boolean);

const fmt = (n) => n == null ? 'N/A' : n.toFixed(1);

console.log('\n  인증 레이턴시 (단일 avg / P95 / P99):');
for (const p of phases) {
  const l = p.authLatency?.latency;
  console.log(\`  \${p.phase}: avg=\${fmt(l?.avg)}ms  P95=\${fmt(l?.p95)}ms  P99=\${fmt(l?.p99)}ms\`);
}

console.log('\n  Credential 발급 avg:');
for (const p of phases) {
  const i = p.issuance;
  if (!i) { console.log(\`  \${p.phase}: bypass\`); continue; }
  console.log(\`  \${p.phase}: avg=\${fmt(i.latency?.avg)}ms  size=\${i.credSizeBytes}B  type=\${i.credType}\`);
}

console.log('\n  스트레스 TPS (20w × 15초):');
for (const p of phases) {
  const st = p.stressTest;
  console.log(\`  \${p.phase}: TPS=\${fmt(st?.tps)}  P99=\${fmt(st?.latency?.p99)}ms  err=\${st?.errorRate}%\`);
}

if (B && C) {
  const bAuth = B.authLatency?.latency?.avg;
  const cAuth = C.authLatency?.latency?.avg;
  const bTps  = B.stressTest?.tps;
  const cTps  = C.stressTest?.tps;
  console.log('\n  B → C 개선 요약:');
  if (bAuth && cAuth) console.log(\`  인증 레이턴시: \${bAuth.toFixed(1)}ms → \${cAuth.toFixed(1)}ms (\${(bAuth/cAuth).toFixed(2)}x 향상)\`);
  if (bTps && cTps)   console.log(\`  스트레스 TPS:  \${bTps} → \${cTps} (\${(cTps/bTps).toFixed(2)}x 향상)\`);
}
" 2>/dev/null || echo "  (결과 파싱 실패)"

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  완료: $(date +'%Y-%m-%d %H:%M:%S')                                  ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
