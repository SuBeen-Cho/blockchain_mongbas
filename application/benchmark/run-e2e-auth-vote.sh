#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

REPORTS_DIR="benchmark-reports"
mkdir -p "$REPORTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TX_PER_ROUND="${E2E_TX_PER_ROUND:-25}"
TPS_LEVELS="${E2E_TPS_LEVELS:-1,5,10,20}"

SERVER_PID=""

log() { echo "[$(date +%H:%M:%S)] $*"; }

start_server() {
  local mode="$1"; shift
  local env_vars="$*"
  log "server start: ${mode}"
  eval "env DISABLE_RATE_LIMITS=true SESSION_SECRET=bench-session-secret CREDENTIAL_SECRET=bench-credential-secret $env_vars node src/app.js > /tmp/mongbas-e2e-server.log 2>&1 &"
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
      curl -s http://localhost:3000/health | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('  mode:', d.idemix.mode, '| impl:', d.idemix.impl);"
      return
    fi
    sleep 0.4
  done
  cat /tmp/mongbas-e2e-server.log
  exit 1
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    log "server stop: ${SERVER_PID}"
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    SERVER_PID=""
    sleep 1
  fi
}

run_mode() {
  local label="$1"; shift
  local env_vars="$*"
  start_server "$label" "$env_vars"
  node benchmark/e2e-vote-auth-bench.js \
    --tps "$TPS_LEVELS" \
    --tx "$TX_PER_ROUND" \
    --out "${REPORTS_DIR}/e2e-${label}-${TIMESTAMP}.json" \
    2>&1 | tee "${REPORTS_DIR}/e2e-${label}-${TIMESTAMP}.log"
  stop_server
}

trap stop_server EXIT

lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

run_mode "A-bypass" "IDEMIX_ENABLED=false"
run_mode "HMAC" "IDEMIX_ENABLED=true ASYM_CRED_ENABLED=false IDEMIX_CACHE_ENABLED=false"
run_mode "Ed25519" "IDEMIX_ENABLED=true ASYM_CRED_ENABLED=true IDEMIX_CACHE_ENABLED=false"
run_mode "B-PS-BN254" "IDEMIX_ENABLED=true IDEMIX_IMPL=ps IDEMIX_CACHE_ENABLED=false"
run_mode "C-BBS" "IDEMIX_ENABLED=true IDEMIX_IMPL=bbs IDEMIX_CACHE_ENABLED=false"

log "done"
ls -lh "${REPORTS_DIR}/e2e-"*"${TIMESTAMP}"*
