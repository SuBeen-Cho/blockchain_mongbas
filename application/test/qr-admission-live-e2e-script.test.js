'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('live QR E2E script keeps admission, credential and nullifier material out of its summary', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/qr-admission-live-e2e.js'), 'utf8');
  const summary = source.slice(source.indexOf("process.stdout.write"));
  assert.match(summary, /mongbas-qr-admission-live-e2e\/v1/);
  assert.doesNotMatch(summary, /admission\.token|issued\.credential|issued\.nullifierMaterial|nullifierHash/);
  assert.match(source, /wrong-election redemption/);
  assert.match(source, /replay redemption/);
  assert.match(source, /credentialVerification/);
  assert.match(source, /E2E_REUSE_ELECTION/);
  assert.match(source, /E2E_REVOTE_SAME_CREDENTIAL/);
  assert.match(source, /E2E_CREDENTIAL_SURRENDER_GAME/);
  assert.match(source, /coercer-and-voter-sequentially-use-the-same-bearer-credential/);
  assert.match(source, /serverDistinguishesCredentialHolder: false/);
  assert.match(source, /credential surrender game requires E2E_REVOTE_SAME_CREDENTIAL=true/);
  assert.match(source, /same-credential replacement was not classified as a revote/);
  assert.match(source, /vote\.revoted === true/);
  assert.match(source, /initialCount \+ 1/);
});
