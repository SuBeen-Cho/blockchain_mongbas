'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../../deploy/linux/quick-tunnel-evaluation.sh'),
  'utf8',
);

test('Quick Tunnel evaluator requires explicit public-exposure approval', () => {
  assert.match(source, /ENABLE_PUBLIC_QUICK_TUNNEL/);
  assert.match(source, /repository must be clean before public exposure/);
  assert.match(source, /cloudflared must run as a non-root operator/);
});

test('Quick Tunnel evaluator gates loopback, admission, and rate limits', () => {
  assert.match(source, /backend port 3000 is not confined to loopback/);
  assert.match(source, /admissionRequired/);
  assert.match(source, /rateLimitsDisabled/);
});

test('Quick Tunnel evaluator accepts only a Cloudflare ephemeral origin and cleans up', () => {
  assert.match(source, /trycloudflare\\\.com/);
  assert.match(source, /getent ahosts/);
  assert.match(source, /cloudflare-dns\.com\/dns-query/);
  assert.match(source, /--resolve/);
  assert.match(source, /seq 1 120/);
  assert.match(source, /kill "\$\{tunnel_pid\}"/);
  assert.match(source, /sha256\.txt/);
  assert.match(source, /strict-transport-security/);
  assert.match(source, /content-security-policy/);
});

test('Quick Tunnel evaluator atomically applies and rolls back the detected origin', () => {
  assert.match(source, /MONGBAS_BACKEND_ENV/);
  assert.match(source, /MONGBAS_ADMISSION_STATE/);
  assert.match(source, /configure-tailnet-qr-profile\.py/);
  assert.match(source, /systemctl restart mongbas-backend\.service/);
  assert.match(source, /stat -c %u/);
  assert.match(source, /stat -c %g/);
  assert.match(source, /install -o "\$\{backend_env_uid\}" -g "\$\{backend_env_gid\}" -m 0600/);
});

test('profile configurator preserves the protected environment owner across atomic replacement', () => {
  const configurator = fs.readFileSync(
    path.join(__dirname, '../../deploy/linux/configure-tailnet-qr-profile.py'),
    'utf8',
  );
  assert.match(configurator, /os\.chown\(temporary, source_stat\.st_uid, source_stat\.st_gid\)/);
});
