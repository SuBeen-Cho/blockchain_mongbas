#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

approval="${1:-}"
[ "${approval}" = "ENABLE_PUBLIC_QUICK_TUNNEL" ] ||
  die "explicit public Quick Tunnel approval argument is required"

ensure_runtime
require_cmd cloudflared
require_cmd curl
require_cmd getent
require_cmd pgrep
require_cmd sha256sum
require_cmd ss

if pgrep -af '[c]loudflared tunnel .*127\.0\.0\.1:3000' >/dev/null 2>&1; then
  die "a Mongbas Quick Tunnel already appears to be active"
fi

stamp="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/quick-tunnel-${stamp}"
(umask 077; mkdir "${out}")
tunnel_pid=""
passed=false

finish() {
  status=$?
  if [ -n "${tunnel_pid}" ] && kill -0 "${tunnel_pid}" 2>/dev/null; then
    kill "${tunnel_pid}" 2>/dev/null || true
    wait "${tunnel_pid}" 2>/dev/null || true
  fi
  printf 'status=%s\nexitCode=%s\nfinishedUtc=%s\n' \
    "$([ "${passed}" = true ] && printf passed || printf failed)" "${status}" "$(date -u +'%FT%TZ')" >"${out}/result.txt"
  find "${out}" -type f ! -name sha256.txt ! -name sha256.txt.tmp -print0 | sort -z |
    xargs -0 -r sha256sum >"${out}/sha256.txt.tmp" || true
  mv "${out}/sha256.txt.tmp" "${out}/sha256.txt" 2>/dev/null || true
}
trap finish EXIT INT TERM

date -u +'%FT%TZ' >"${out}/started-utc.txt"
cloudflared --version >"${out}/cloudflared-version.txt" 2>&1
git -C "${MONGBAS_REPO_DIR}" rev-parse HEAD >"${out}/git-commit.txt"
git -C "${MONGBAS_REPO_DIR}" status --short --branch >"${out}/git-status.txt"
[ -z "$(git -C "${MONGBAS_REPO_DIR}" status --porcelain --untracked-files=normal)" ] ||
  die "repository must be clean before public exposure"

ss -lnt >"${out}/listeners-before.txt"
if ss -lntH '( sport = :3000 )' | awk '{print $4}' | grep -Evq '^(127\.0\.0\.1|\[::1\]):3000$'; then
  die "backend port 3000 is not confined to loopback"
fi
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3000/health >"${out}/loopback-health-before.json"
grep -Eq '"admissionRequired"[[:space:]]*:[[:space:]]*true' "${out}/loopback-health-before.json" ||
  die "demo admission must be required before public exposure"
grep -Eq '"rateLimitsDisabled"[[:space:]]*:[[:space:]]*false' "${out}/loopback-health-before.json" ||
  die "rate limits must remain enabled before public exposure"

cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 \
  >"${out}/cloudflared.stdout.log" 2>"${out}/cloudflared.stderr.log" &
tunnel_pid=$!
printf '%s\n' "${tunnel_pid}" >"${out}/cloudflared.pid"

origin=""
for _ in $(seq 1 60); do
  kill -0 "${tunnel_pid}" 2>/dev/null || die "cloudflared exited before publishing an origin"
  origin="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${out}/cloudflared.stderr.log" | tail -1 || true)"
  [ -z "${origin}" ] || break
  sleep 1
done
[ -n "${origin}" ] || die "timed out waiting for a valid trycloudflare.com origin"
printf '%s\n' "${origin}" >"${out}/https-origin.txt"

for _ in $(seq 1 120); do
  if ! getent ahosts "${origin#https://}" >"${out}/origin-addresses.txt.tmp" 2>/dev/null; then
    sleep 1
    continue
  fi
  mv "${out}/origin-addresses.txt.tmp" "${out}/origin-addresses.txt"
  if curl --fail --silent --show-error --max-time 15 \
    "${origin}/health" >"${out}/https-health.json" 2>"${out}/https-health.stderr"; then
    break
  fi
  sleep 1
done
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "${out}/https-health.json" ||
  die "public HTTPS health check failed"
curl --fail --silent --show-error --max-time 15 --dump-header "${out}/https-headers.txt" \
  --output /dev/null "${origin}/"
grep -Eqi '^strict-transport-security:' "${out}/https-headers.txt" || die "HTTPS response is missing HSTS"
grep -Eqi '^content-security-policy:' "${out}/https-headers.txt" || die "HTTPS response is missing CSP"

passed=true
log "Quick Tunnel HTTPS preflight passed; evidence: ${out}"
log "The temporary origin is stored mode-private in ${out}/https-origin.txt"
log "Press Ctrl-C after the phone demonstration; the tunnel process will be terminated and evidence sealed."
wait "${tunnel_pid}"
