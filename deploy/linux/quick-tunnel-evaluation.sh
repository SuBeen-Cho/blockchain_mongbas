#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

approval="${1:-}"
[ "${approval}" = "ENABLE_PUBLIC_QUICK_TUNNEL" ] ||
  die "explicit public Quick Tunnel approval argument is required"
[ "${EUID}" -ne 0 ] || die "cloudflared must run as a non-root operator"

ensure_runtime
require_cmd cloudflared
require_cmd curl
require_cmd getent
require_cmd node
require_cmd pgrep
require_cmd sha256sum
require_cmd ss
require_cmd sudo

backend_env="${MONGBAS_BACKEND_ENV:-}"
admission_state="${MONGBAS_ADMISSION_STATE:-}"
[ -n "${backend_env}" ] && [ "${backend_env#/}" != "${backend_env}" ] ||
  die "MONGBAS_BACKEND_ENV must be an explicit absolute path"
[ -n "${admission_state}" ] && [ "${admission_state#/}" != "${admission_state}" ] ||
  die "MONGBAS_ADMISSION_STATE must be an explicit absolute path"

if pgrep -af '[c]loudflared tunnel .*127\.0\.0\.1:3000' >/dev/null 2>&1; then
  die "a Mongbas Quick Tunnel already appears to be active"
fi

stamp="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/quick-tunnel-${stamp}"
(umask 077; mkdir "${out}")
tunnel_pid=""
passed=false
profile_applied=false
profile_backup="${backend_env}.quick-tunnel-${stamp}.bak"

finish() {
  status=$?
  if [ -n "${tunnel_pid}" ] && kill -0 "${tunnel_pid}" 2>/dev/null; then
    kill "${tunnel_pid}" 2>/dev/null || true
    wait "${tunnel_pid}" 2>/dev/null || true
  fi
  if [ "${profile_applied}" = true ] && [ -f "${profile_backup}" ]; then
    sudo install -m 0600 "${profile_backup}" "${backend_env}" || true
    sudo systemctl restart mongbas-backend.service || true
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

# Privilege separation: the temporary tunnel remains owned by the invoking
# operator. sudo is used only for the protected environment update and backend
# restart, and no password or token is passed through arguments or files.
sudo python3 "${MONGBAS_REPO_DIR}/deploy/linux/configure-tailnet-qr-profile.py" \
  "${backend_env}" "${origin}" "${profile_backup}" "${admission_state}"
profile_applied=true
sudo systemctl restart mongbas-backend.service

origin_host="${origin#https://}"
for _ in $(seq 1 120); do
  probe_args=()
  if getent ahosts "${origin_host}" >"${out}/origin-addresses.txt.tmp" 2>/dev/null; then
    mv "${out}/origin-addresses.txt.tmp" "${out}/origin-addresses.txt"
  else
    rm -f "${out}/origin-addresses.txt.tmp"
    if curl --fail --silent --show-error --max-time 10 -H 'accept: application/dns-json' \
      "https://cloudflare-dns.com/dns-query?name=${origin_host}&type=A" >"${out}/origin-doh.json.tmp" 2>/dev/null; then
      edge_ip="$(node - "${out}/origin-doh.json.tmp" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ip = body.Answer?.map(({ data }) => data).find(value =>
  typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value));
if (!ip) process.exit(1);
process.stdout.write(ip);
NODE
)"
      if [ -n "${edge_ip}" ]; then
        mv "${out}/origin-doh.json.tmp" "${out}/origin-doh.json"
        probe_args=(--resolve "${origin_host}:443:${edge_ip}")
      fi
    fi
  fi
  if curl "${probe_args[@]}" --fail --silent --show-error --max-time 15 \
    "${origin}/health" >"${out}/https-health.json" 2>"${out}/https-health.stderr"; then
    break
  fi
  sleep 1
done
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "${out}/https-health.json" ||
  die "public HTTPS health check failed"
curl --fail --silent --show-error --max-time 15 --dump-header "${out}/https-headers.txt" \
  "${probe_args[@]}" --output /dev/null "${origin}/"
grep -Eqi '^strict-transport-security:' "${out}/https-headers.txt" || die "HTTPS response is missing HSTS"
grep -Eqi '^content-security-policy:' "${out}/https-headers.txt" || die "HTTPS response is missing CSP"

passed=true
log "Quick Tunnel HTTPS preflight passed; evidence: ${out}"
log "The temporary origin is stored mode-private in ${out}/https-origin.txt"
log "Press Ctrl-C after the phone demonstration; the tunnel process will be terminated and evidence sealed."
wait "${tunnel_pid}"
