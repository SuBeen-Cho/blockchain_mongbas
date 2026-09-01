'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateVectorBallot, verifyVectorAuditWitness } = require('../src/lib/vectorElgamal');

// Small safe-prime group is sufficient for deterministic structural unit tests.
const PUB = { p: '17', g: '2', y: '8' }; // p=23, q=11, y=g^3

test('generated vector-v3 witness independently reconstructs every ciphertext', () => {
  for (let selectedIndex = 0; selectedIndex < 3; selectedIndex += 1) {
    const ballot = generateVectorBallot(PUB, selectedIndex, 3);
    assert.equal(verifyVectorAuditWitness(PUB, ballot.encryptedCandidateVector, ballot._auditWitness), true);
  }
});

test('audit witness is not serialized with the ballot artifact', () => {
  const ballot = generateVectorBallot(PUB, 1, 3);
  assert.equal(Object.prototype.propertyIsEnumerable.call(ballot, '_auditWitness'), false);
  assert.equal(JSON.stringify(ballot).includes('randomness'), false);
  assert.equal(JSON.stringify(ballot).includes('selectedIndex'), false);
});

test('witness verification rejects selection, randomness, ciphertext and shape tampering', () => {
  const ballot = generateVectorBallot(PUB, 1, 3);
  const witness = ballot._auditWitness;
  assert.equal(verifyVectorAuditWitness(PUB, ballot.encryptedCandidateVector, { ...witness, selectedIndex: 0 }), false);
  assert.equal(verifyVectorAuditWitness(PUB, ballot.encryptedCandidateVector, { ...witness, randomness: ['0', ...witness.randomness.slice(1)] }), false);
  assert.equal(verifyVectorAuditWitness(PUB, ballot.encryptedCandidateVector, { ...witness, randomness: [`0${witness.randomness[0]}`, ...witness.randomness.slice(1)] }), false);
  const changed = structuredClone(ballot.encryptedCandidateVector);
  changed[2].c2 = changed[2].c2 === '1' ? '2' : '1';
  assert.equal(verifyVectorAuditWitness(PUB, changed, witness), false);
  assert.equal(verifyVectorAuditWitness(PUB, ballot.encryptedCandidateVector, { selectedIndex: 1, randomness: [] }), false);
});
