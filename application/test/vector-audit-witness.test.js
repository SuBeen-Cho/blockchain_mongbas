'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateVectorBallot, verifyVectorAuditWitness, vectorArtifactHash } = require('../src/lib/vectorElgamal');

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

test('artifact hash is stable across object key order and binds election and candidate order', () => {
  const ballot = generateVectorBallot(PUB, 1, 3);
  const base = {
    electionID: 'election-a',
    candidates: ['A', 'B', 'C'],
    encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: ballot.vectorBallotValidityProof,
  };
  const reorderedProof = {
    sumProof: {
      z: base.vectorBallotValidityProof.sumProof.z,
      e: base.vectorBallotValidityProof.sumProof.e,
      a2: base.vectorBallotValidityProof.sumProof.a2,
      a1: base.vectorBallotValidityProof.sumProof.a1,
    },
    bitProofs: base.vectorBallotValidityProof.bitProofs.map(proof => ({
      zs: proof.zs, es: proof.es, a2s: proof.a2s, a1s: proof.a1s,
    })),
  };
  const hash = vectorArtifactHash(base);
  assert.equal(vectorArtifactHash({ ...base, vectorBallotValidityProof: reorderedProof }), hash);
  assert.notEqual(vectorArtifactHash({ ...base, electionID: 'election-b' }), hash);
  assert.notEqual(vectorArtifactHash({ ...base, candidates: ['B', 'A', 'C'] }), hash);
});

test('artifact hash rejects incomplete and non-canonical values', () => {
  assert.throws(() => vectorArtifactHash({ electionID: 'e', candidates: ['A'] }), /invalid/);
  const ballot = generateVectorBallot(PUB, 0, 2);
  assert.throws(() => vectorArtifactHash({
    electionID: 'e', candidates: ['A', 'B'], encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: { ...ballot.vectorBallotValidityProof, unexpected: undefined },
  }), /non-canonical/);
});
