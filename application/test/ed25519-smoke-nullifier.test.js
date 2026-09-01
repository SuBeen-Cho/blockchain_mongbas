'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { credentialNullifierMaterial, sha256Hex } = require('../scripts/ed25519-e2e-smoke');
const { computeCredentialBoundNullifier } = require('../src/lib/credentialBinding');

function unsignedFixture(nonce = 'signed-nullifier-material') {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    voterEligible: '1', electionID: 'election-a', nonce, exp: Date.now() + 60_000,
  })).toString('base64url');
  return `${header}.${payload}.fixture-signature`;
}

test('Ed25519 smoke derives the vote nullifier from signed credential material', () => {
  const credential = unsignedFixture();
  const material = credentialNullifierMaterial(credential);
  assert.equal(material, 'signed-nullifier-material');
  assert.equal(
    computeCredentialBoundNullifier(material, 'election-a', 'blind-a'),
    '18e2a35fc0db529fc5eccd08f5252a2c2e91685c78d25bf6dc12580959677ce5',
  );
});

test('credential-bound nullifier helper fails closed on missing inputs', () => {
  assert.equal(
    computeCredentialBoundNullifier('signed-material', 'election-a', 'blind-a'),
    sha256Hex('signed-materialelection-ablind-a'),
  );
  assert.throws(() => computeCredentialBoundNullifier('', 'election-a', 'blind-a'), /non-empty strings/);
  assert.throws(() => computeCredentialBoundNullifier('signed-material', '', 'blind-a'), /non-empty strings/);
  assert.throws(() => computeCredentialBoundNullifier('signed-material', 'election-a', ''), /non-empty strings/);
});

test('Ed25519 smoke rejects missing or malformed signed nullifier material', () => {
  assert.throws(() => credentialNullifierMaterial('broken'), /Expected Ed25519/);
  assert.throws(() => credentialNullifierMaterial(unsignedFixture('')), /no nullifier material/);
});
