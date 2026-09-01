'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDENTIAL_SECRET = 'credential-nullifier-binding-test-secret-at-least-32-bytes';
process.env.ENABLE_DEMO_CREDENTIALS = 'false';

const { issueCredential } = require('../src/routes/credential');
const { verifyCredential } = require('../src/middleware/auth');

function payload(token) {
  return JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8'));
}

test('HMAC credential reissuance preserves voter/election nullifier material', () => {
  const first = issueCredential('alice', 'election-a');
  const second = issueCredential('alice', 'election-a');
  assert.equal(payload(first).nonce, payload(second).nonce);
  assert.notEqual(payload(first).nonce, payload(issueCredential('bob', 'election-a')).nonce);
  assert.notEqual(payload(first).nonce, payload(issueCredential('alice', 'election-b')).nonce);
});

test('verified credential exposes only its signed nullifier material', () => {
  const token = issueCredential('alice', 'election-a');
  const verified = verifyCredential(token);
  assert.equal(verified.valid, true);
  assert.equal(verified.nullifierMaterial, payload(token).nonce);

  const [body, signature] = token.split('.');
  const tamperedPayload = { ...payload(token), nonce: 'attacker-controlled' };
  const tampered = `${Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url')}.${signature}`;
  assert.equal(verifyCredential(tampered).valid, false);
  assert.notEqual(body, tampered.split('.')[0]);
});
