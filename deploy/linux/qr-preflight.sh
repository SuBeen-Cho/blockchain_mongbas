#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Read-only preflight for the real-phone QR profile. This command deliberately
# does not source or print the secret environment file, alter systemd/Docker,
# configure Tailscale Serve, or make a Fabric transaction.
runtime_paths
failures=0
warnings=0

pass() { log "PASS $*"; }
fail() { log "FAIL $*"; failures=$((failures + 1)); }
warn() { log "WARN $*"; warnings=$((warnings + 1)); }

require_cmd git
require_cmd curl
require_cmd docker

branch="$(git -C "${MONGBAS_REPO_DIR}" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
commit="$(git -C "${MONGBAS_REPO_DIR}" rev-parse --verify HEAD 2>/dev/null || true)"
if [ -n "${branch}" ] && [ "${#commit}" -eq 40 ]; then
  pass "repository is attached to ${branch} at ${commit:0:12}"
else
  fail "repository must be on an attached branch with a valid commit"
fi

if [ -z "$(git -C "${MONGBAS_REPO_DIR}" status --porcelain --untracked-files=normal)" ]; then
  pass "repository worktree is clean"
else
  fail "repository worktree is dirty; do not deploy an unrecorded QR build"
fi

if [ -f "${MONGBAS_ENV_FILE}" ]; then
  mode="$(stat -c '%a' "${MONGBAS_ENV_FILE}" 2>/dev/null || true)"
  [ "${mode}" = 600 ] && pass "runtime env exists with mode 0600" || fail "runtime env must have mode 0600"
  for setting in ADMIN_API_TOKEN CREDENTIAL_SECRET AUDIT_HMAC_KEY CORS_ORIGIN; do
    if grep -Eq "^[[:space:]]*${setting}=.+" "${MONGBAS_ENV_FILE}"; then
      pass "${setting} is configured"
    else
      fail "${setting} must be configured"
    fi
  done
  for expected in 'ENABLE_DEMO_ENDPOINTS=true' 'REQUIRE_DEMO_ADMISSION=true' 'ENABLE_DEMO_CREDENTIALS=true'; do
    if grep -Eq "^[[:space:]]*${expected}[[:space:]]*$" "${MONGBAS_ENV_FILE}"; then
      pass "${expected}"
    else
      fail "QR demo profile requires ${expected}"
    fi
  done
  if grep -Eq '^[[:space:]]*(ALLOW_BYPASS_CREDENTIAL|DISABLE_RATE_LIMITS)=true[[:space:]]*$' "${MONGBAS_ENV_FILE}"; then
    fail "unsafe credential bypass or rate-limit bypass is enabled"
  else
    pass "credential and rate-limit bypass flags are disabled"
  fi
else
  fail "runtime env is missing"
fi

required_containers=(
  orderer1.orderer.voting.example.com
  peer0.ec.voting.example.com
  peer0.party.voting.example.com
  peer0.civil.voting.example.com
  voting-chaincode
)
for name in "${required_containers[@]}"; do
  state="$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null || true)"
  [ "${state}" = running ] && pass "container ${name} is running" || fail "container ${name} is not running"
done

base_url="${MONGBAS_BASE_URL:-http://127.0.0.1:3000}"
if health="$(curl --fail --silent --show-error --max-time 5 "${base_url}/health" 2>/dev/null)" &&
   printf '%s' "${health}" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  pass "backend health endpoint reports ok"
else
  fail "backend health endpoint is unavailable or unhealthy"
fi

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status --json >/dev/null 2>&1; then
    pass "Tailscale daemon is reachable"
  else
    fail "Tailscale daemon is unavailable"
  fi
  serve_state="$(tailscale serve status 2>&1 || true)"
  if printf '%s' "${serve_state}" | grep -qi 'No serve config'; then
    warn "Tailscale Serve is not configured (approval required before changing it)"
  elif [ -n "${serve_state}" ]; then
    pass "Tailscale Serve has a configuration; inspect it separately before use"
  else
    warn "Tailscale Serve status could not be classified"
  fi
else
  fail "tailscale CLI is missing"
fi

if [ "${branch}" = feat/ballot-history-consistency ]; then
  pass "feature branch contains the QR/history producer integration"
else
  warn "checkout is not feat/ballot-history-consistency; do not claim the feature QR/history path"
fi

log "SUMMARY failures=${failures} warnings=${warnings}"
[ "${failures}" -eq 0 ]
