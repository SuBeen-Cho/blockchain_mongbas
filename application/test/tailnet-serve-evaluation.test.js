'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Serve evidence wrapper is tailnet-only, non-overwriting and rollback-capable', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../deploy/linux/tailnet-serve-evaluation.sh'), 'utf8');
  assert.match(source, /ENABLE_TAILNET_ONLY_SERVE/);
  assert.match(source, /pgrep -af '\[v\]erifier-evaluation\\\.sh'/);
  assert.match(source, /endsWith\('\.ts\.net\.'\)/);
  assert.match(source, /No serve config/);
  assert.match(source, /tailscale serve --bg --yes http:\/\/127\.0\.0\.1:3000/);
  assert.match(source, /tailscale serve reset/);
  assert.match(source, /https-health\.json/);
  assert.match(source, /strict-transport-security/);
  assert.match(source, /content-security-policy/);
  assert.match(source, /sha256\.txt/);
  assert.doesNotMatch(source, /tailscale funnel|0\.0\.0\.0:3000/);
});
