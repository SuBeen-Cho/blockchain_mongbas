'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RESPONSE_BYTES, deriveLookupToken, isCanonicalToken, serializeFixedProof } = require('../src/lib/deniableProof');

const h = value => require('node:crypto').createHash('sha256').update(value).digest('hex');

test('opaque lookup tokens are domain-bound, deterministic and mode-independent in shape', () => {
  const nonce = h('receipt nonce');
  const normal = deriveLookupToken('normal-password', nonce, 'election-a');
  const panic = deriveLookupToken('panic-password', nonce, 'election-a');
  assert.equal(isCanonicalToken(normal), true);
  assert.equal(isCanonicalToken(panic), true);
  assert.notEqual(normal, panic);
  assert.equal(normal, deriveLookupToken('normal-password', nonce, 'election-a'));
  assert.notEqual(normal, deriveLookupToken('normal-password', nonce, 'election-b'));
});

test('fixed proof projection removes target nullifier/candidate/ciphertext and equalizes bytes', () => {
  const path = [{ hash: h('sibling-a'), position: 'left' }, { hash: h('sibling-b'), position: 'right' }];
  const normal = serializeFixedProof('election-a', {
    nullifierHash: h('real ballot'), candidateID: 'A', encryptedCandidateID: 'short', leafHash: h('real leaf'), proof: path,
  });
  const panic = serializeFixedProof('election-a', {
    nullifierHash: h('dummy ballot'), candidateID: 'A-CANDIDATE-WITH-A-LONG-NAME', encryptedCandidateID: 'x'.repeat(400),
    leafHash: h('dummy leaf'), proof: path,
  });
  assert.equal(Buffer.byteLength(normal), RESPONSE_BYTES);
  assert.equal(Buffer.byteLength(panic), RESPONSE_BYTES);
  for (const forbidden of [h('real ballot'), h('dummy ballot'), 'A-CANDIDATE-WITH-A-LONG-NAME', 'x'.repeat(100)]) {
    assert.equal(normal.includes(forbidden) || panic.includes(forbidden), false);
  }
  assert.deepEqual(Object.keys(JSON.parse(normal)), Object.keys(JSON.parse(panic)));
});

test('lookup input and proof shape fail closed', () => {
  assert.throws(() => deriveLookupToken('short', h('n'), 'e'), /at least 8/);
  assert.throws(() => serializeFixedProof('e', { leafHash: 'bad', proof: [] }), /invalid chaincode proof/);
});
