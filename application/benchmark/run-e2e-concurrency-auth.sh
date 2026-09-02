#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

REPORTS_DIR="benchmark-reports"
mkdir -p "$REPORTS_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CONCURRENCIES="${E2E_CONCURRENCIES:-20,50,100,200,500}"
STOP_FAIL_RATE="${E2E_STOP_FAIL_RATE:-30}"
MODES="${E2E_MODES:-HMAC,B-PS-BN254,C-BBS}"

SERVER_PID=""

log() { echo "[$(date +%H:%M:%S)] $*"; }

start_server() {
  local mode="$1"; shift
  local env_vars="$*"
  local expected_health_mode expected_health_impl
  case "${mode}" in
    HMAC) expected_health_mode=idemix-hmac; expected_health_impl=HMAC-SHA256 ;;
    B-PS-BN254) expected_health_mode=idemix-ps; expected_health_impl='PS-BN254 credential prototype' ;;
    C-BBS) expected_health_mode=idemix-bbs; expected_health_impl='BBS+-BLS12381 (C단계: 개선 Idemix)' ;;
    *) echo "unknown mode: ${mode}" >&2; exit 1 ;;
  esac
  log "server start: ${mode}"
  eval "env DISABLE_RATE_LIMITS=true SESSION_SECRET=bench-session-secret CREDENTIAL_SECRET=bench-credential-secret $env_vars node src/app.js > /tmp/mongbas-saturation-server.log 2>&1 &"
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error http://localhost:3000/health | \
      EXPECTED_HEALTH_MODE="${expected_health_mode}" EXPECTED_HEALTH_IMPL="${expected_health_impl}" node -e '
        const d = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        if (d.status !== "ok" || d.idemix?.mode !== process.env.EXPECTED_HEALTH_MODE || d.idemix?.impl !== process.env.EXPECTED_HEALTH_IMPL) process.exit(1);
        console.log("  mode:", d.idemix.mode, "| impl:", d.idemix.impl);
      '; then
      return
    fi
    sleep 0.5
  done
  cat /tmp/mongbas-saturation-server.log
  exit 1
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    log "server stop: ${SERVER_PID}"
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
    SERVER_PID=""
    sleep 2
  fi
}

run_mode() {
  local label="$1"
  local env_vars=""
  case "$label" in
    HMAC) env_vars="IDEMIX_ENABLED=true ASYM_CRED_ENABLED=false IDEMIX_CACHE_ENABLED=false" ;;
    B-PS-BN254) env_vars="IDEMIX_ENABLED=true IDEMIX_IMPL=ps IDEMIX_CACHE_ENABLED=false" ;;
    C-BBS) env_vars="IDEMIX_ENABLED=true IDEMIX_IMPL=bbs IDEMIX_CACHE_ENABLED=false" ;;
    *) echo "unknown mode: $label"; exit 1 ;;
  esac
  start_server "$label" "$env_vars"
  node benchmark/e2e-concurrency-auth-bench.js \
    --conc "$CONCURRENCIES" \
    --stopFailRate "$STOP_FAIL_RATE" \
    --out "${REPORTS_DIR}/saturation-${label}-${TIMESTAMP}.json" \
    2>&1 | tee "${REPORTS_DIR}/saturation-${label}-${TIMESTAMP}.log"
  stop_server
}

trap stop_server EXIT

lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

IFS=',' read -ra MODE_LIST <<< "$MODES"
for mode in "${MODE_LIST[@]}"; do
  run_mode "$mode"
done

log "done"
ls -lh "${REPORTS_DIR}/saturation-"*"${TIMESTAMP}"*
