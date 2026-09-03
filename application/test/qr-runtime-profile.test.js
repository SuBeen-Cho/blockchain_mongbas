'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('tailnet QR profile updater backs up and atomically restricts the backend', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-qr-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, 'backend.env'), backupPath = path.join(directory, 'backend.before.env');
  const original = [
    'ADMIN_API_TOKEN=' + 'a'.repeat(32),
    'CREDENTIAL_SECRET=' + 'b'.repeat(32),
    'AUDIT_HMAC_KEY=' + 'c'.repeat(32),
    'CORS_ORIGIN=https://node.tail.example,http://localhost:3000',
    'LISTEN_HOST=0.0.0.0',
    '',
  ].join('\n');
  fs.writeFileSync(envPath, original, { mode: 0o600 });
  const script = path.join(__dirname, '../../deploy/linux/configure-tailnet-qr-profile.py');
  const result = spawnSync('python3', [script, envPath, 'https://node.tail.example', backupPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), original);
  const updated = fs.readFileSync(envPath, 'utf8');
  assert.match(updated, /^LISTEN_HOST=127\.0\.0\.1$/m);
  assert.match(updated, /^ENABLE_HSTS=true$/m);
  assert.match(updated, /^TRUST_PROXY_HOPS=1$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /a{32}|b{32}|c{32}/);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.notEqual(spawnSync('python3', [script, envPath, 'https://node.tail.example', backupPath]).status, 0,
    'an existing backup must never be replaced');
});
