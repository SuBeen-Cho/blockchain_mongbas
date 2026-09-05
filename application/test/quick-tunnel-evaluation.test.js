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
