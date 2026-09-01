'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCredentialRevocationHandle } = require('../src/lib/credentialRevocation');

test('credential revocation handle matches the frozen Go/Node vector', () => {
  const got = computeCredentialRevocationHandle('signed-material', 'election-a', 'blind-a');
  assert.equal(got, '8cabe1a5ba7fa8135d53ed00af40bad3953e1d814f74c9f33267e5f5489fd6d4');
  assert.equal(got, computeCredentialRevocationHandle('signed-material', 'election-a', 'blind-a'));
  assert.notEqual(got, computeCredentialRevocationHandle('signed-material', 'election-b', 'blind-b'));
});

test('credential revocation handle rejects missing and non-string inputs', () => {
  for (const fields of [
    ['', 'election-a', 'blind-a'],
    ['signed-material', '', 'blind-a'],
    ['signed-material', 'election-a', ''],
    [null, 'election-a', 'blind-a'],
  ]) {
    assert.throws(() => computeCredentialRevocationHandle(...fields), /non-empty strings/);
  }
});
