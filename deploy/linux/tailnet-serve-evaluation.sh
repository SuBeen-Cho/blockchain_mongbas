#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

approval="${1:-}"
[ "${approval}" = "ENABLE_TAILNET_ONLY_SERVE" ] || die "explicit tailnet-only Serve approval argument is required"

ensure_runtime
require_cmd curl
require_cmd node
require_cmd sha256sum
require_cmd tailscale

if pgrep -af '[v]erifier-evaluation\.sh' >/dev/null 2>&1; then
  die "verifier evaluation is active; configure Serve only after it exits"
fi

stamp="$(timestamp_utc)"
out="${MONGBAS_RESULT_DIR}/tailnet-serve-${stamp}"
(umask 077; mkdir "${out}")
changed=false
passed=false

finish() {
  status=$?
  if [ "${changed}" = true ] && [ "${passed}" != true ]; then
    tailscale serve reset >"${out}/rollback.stdout.log" 2>"${out}/rollback.stderr.log" || true
    tailscale serve status >"${out}/serve-after-rollback.txt" 2>&1 || true
  fi
  printf 'status=%s\nexitCode=%s\nfinishedUtc=%s\n' \
    "$([ "${passed}" = true ] && printf passed || printf failed)" "${status}" "$(date -u +'%FT%TZ')" >"${out}/result.txt"
  find "${out}" -type f ! -name sha256.txt ! -name sha256.txt.tmp -print0 | sort -z |
    xargs -0 -r sha256sum >"${out}/sha256.txt.tmp" || true
  mv "${out}/sha256.txt.tmp" "${out}/sha256.txt" 2>/dev/null || true
}
trap finish EXIT

date -u +'%FT%TZ' >"${out}/started-utc.txt"
tailscale version >"${out}/tailscale-version.txt"
tailscale status --json >"${out}/tailscale-status.json"
tailscale serve status >"${out}/serve-before.txt" 2>&1 || true
grep -qi '^No serve config' "${out}/serve-before.txt" ||
  die "an existing Serve configuration is present; refuse to overwrite it"

dns_name="$(node - "${out}/tailscale-status.json" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const value = status?.Self?.DNSName;
if (typeof value !== 'string' || !/^[A-Za-z0-9.-]+\.$/.test(value) || !value.endsWith('.ts.net.')) process.exit(1);
process.stdout.write(value.slice(0, -1));
NODE
)"
origin="https://${dns_name}"
printf '%s\n' "${origin}" >"${out}/https-origin.txt"

# The protected backend must already be live on loopback before changing Serve.
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/health >"${out}/loopback-health-before.json"
ss -lnt >"${out}/listeners-before.txt"
if ss -lntH '( sport = :3000 )' | awk '{print $4}' | grep -Evq '^(127\.0\.0\.1|\[::1\]):3000$'; then
  die "backend port 3000 is not confined to loopback"
fi

tailscale serve --bg --yes http://127.0.0.1:3000 >"${out}/serve-enable.stdout.log" 2>"${out}/serve-enable.stderr.log"
changed=true
tailscale serve status >"${out}/serve-after.txt" 2>&1
tailscale serve status --json >"${out}/serve-after.json" 2>&1

curl --fail --silent --show-error --max-time 15 "${origin}/health" >"${out}/https-health.json"
curl --silent --show-error --max-time 15 --dump-header "${out}/https-headers.txt" --output /dev/null "${origin}/"
grep -Eqi '^strict-transport-security:' "${out}/https-headers.txt" || die "HTTPS response is missing HSTS"
grep -Eqi '^content-security-policy:' "${out}/https-headers.txt" || die "HTTPS response is missing CSP"
passed=true
log "tailnet-only Serve HTTPS passed: ${origin}"
log "evidence: ${out}"
