'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('direct Fabric credential corpus has nine attacks and emits no credential material', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/direct-fabric-credential-attack.js'), 'utf8');
  for (const label of ['missing credential verification', 'malformed credential verification', 'unknown credential type',
    'expired credential metadata', 'forged credential token', 'arbitrary nullifier', 'cross-election credential',
    'missing history nonce', 'revoked credential']) assert.match(source, new RegExp(label));
  const summary = source.slice(source.indexOf("schema: 'mongbas-direct-fabric-credential-attack/v1'"));
  assert.doesNotMatch(summary, /nullifierA|nullifierB|credentialA|credentialB|material|token:/);
});
