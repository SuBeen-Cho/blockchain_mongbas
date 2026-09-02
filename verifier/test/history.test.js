'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalize } = require('../src/verify');
const {
  ballotCommitment,
  createConsistencyProof,
  createHistory,
  historyCommitments,
  historyContextHash,
  merkleTreeHash,
  verifyConsistencyProof,
} = require('../src/history');

const digest = (...parts) => {
  const hash = crypto.createHash('sha256');
  parts.forEach(part => hash.update(part));
  return hash.digest();
};

function referenceMth(leaves) {
  if (leaves.length === 0) return digest(Buffer.alloc(0));
  if (leaves.length === 1) return digest(Buffer.from([0]), leaves[0]);
  let split = 1;
  while (split * 2 < leaves.length) split *= 2;
  return digest(Buffer.from([1]), referenceMth(leaves.slice(0, split)), referenceMth(leaves.slice(split)));
}

function bundle(ballotCount = 7) {
  return {
    schema: 'mongbas-election-bundle/v-test',
    algorithms: { encryption: 'test-elgamal', proof: 'test-proof' },
    configuration: {
      electionID: 'history-test', candidates: ['ALICE', 'BOB'],
      organizations: [{ id: 'Org1' }, { id: 'Org2' }], signatureThreshold: 2,
    },
    publicKey: { p: '17', q: 'b', g: '2', y: '4' },
    trusteePublicShares: [{ index: 1, value: '4' }, { index: 2, value: '8' }],
    keyCeremony: { transcriptHash: '11'.repeat(32) },
    ballots: Array.from({ length: ballotCount }, (_, index) => ({
      preparedBallotID: `prepared-${index}`,
      nullifierHash: digest(Buffer.from(`nullifier-${index}`)).toString('hex'),
      ciphertextVector: [{ c1: `${index + 2}`, c2: `${index + 3}` }],
      validityProof: { e: `${index + 4}`, z: `${index + 5}` },
    })),
  };
}

test('history MTH matches a separately structured reference at tree boundaries', () => {
  for (let size = 0; size <= 64; size += 1) {
    const leaves = Array.from({ length: size }, (_, index) => digest(Buffer.from(`leaf-${index}`)));
    assert.equal(merkleTreeHash(leaves).toString('hex'), referenceMth(leaves).toString('hex'), `size ${size}`);
  }
});

test('history commitment binds full ballot and immutable election context', () => {
  const original = bundle(1);
  const context = historyContextHash(original);
  const first = ballotCommitment(context, original.ballots[0]).toString('hex');

  const ballotChanged = structuredClone(original);
  ballotChanged.ballots[0].preparedBallotID = 'different';
  assert.notEqual(ballotCommitment(context, ballotChanged.ballots[0]).toString('hex'), first);

  for (const mutate of [
    value => value.configuration.candidates.reverse(),
    value => { value.publicKey.y = '5'; },
    value => { value.algorithms.proof = 'downgraded'; },
    value => { value.trusteePublicShares[0].value = '9'; },
    value => { value.keyCeremony.transcriptHash = '22'.repeat(32); },
    value => { value.configuration.organizations.pop(); },
    value => { value.configuration.signatureThreshold = 1; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(historyContextHash(changed), context);
  }
});

test('generated consistency proofs verify exhaustively through size 64', () => {
  const { commitments } = historyCommitments(bundle(64));
  for (let newSize = 0; newSize <= 64; newSize += 1) {
    const prefix = commitments.slice(0, newSize);
    const newRootHash = merkleTreeHash(prefix).toString('hex');
    for (let oldSize = 0; oldSize <= newSize; oldSize += 1) {
      const oldRootHash = merkleTreeHash(prefix, 0, oldSize).toString('hex');
      const consistencyPath = createConsistencyProof(prefix, oldSize);
      assert.equal(verifyConsistencyProof({ oldSize, newSize, oldRootHash, newRootHash, consistencyPath }), true,
        `${oldSize}->${newSize}: ${canonicalize(consistencyPath)}`);
    }
  }
});

test('consistency verification rejects mutation, reorder, duplication and transplantation', () => {
  const { commitments } = historyCommitments(bundle(7));
  const oldSize = 3, newSize = 7;
  const oldRootHash = merkleTreeHash(commitments, 0, oldSize).toString('hex');
  const newRootHash = merkleTreeHash(commitments).toString('hex');
  const consistencyPath = createConsistencyProof(commitments, oldSize);
  const check = path => verifyConsistencyProof({ oldSize, newSize, oldRootHash, newRootHash, consistencyPath: path });
  assert.equal(check(consistencyPath), true);

  const flipped = consistencyPath.slice();
  flipped[0] = `${flipped[0][0] === '0' ? '1' : '0'}${flipped[0].slice(1)}`;
  assert.equal(check(flipped), false);
  assert.equal(check(consistencyPath.slice(1)), false);
  assert.throws(() => check([...consistencyPath, consistencyPath.at(-1)]), /too many/);
  assert.equal(check(consistencyPath.slice().reverse()), false);

  const other = commitments.slice();
  other[1] = digest(Buffer.from('transplanted-prefix'));
  const transplanted = createConsistencyProof(other, 3);
  assert.equal(check(transplanted), false);
});

test('consistency proof input is strict and bounded', () => {
  const empty = digest(Buffer.alloc(0)).toString('hex');
  assert.equal(verifyConsistencyProof({ oldSize: 0, newSize: 0, oldRootHash: empty, newRootHash: empty, consistencyPath: [] }), true);
  assert.throws(() => verifyConsistencyProof({ oldSize: 2, newSize: 1, oldRootHash: empty, newRootHash: empty, consistencyPath: [] }), /cannot exceed/);
  assert.throws(() => verifyConsistencyProof({ oldSize: 0, newSize: 1, oldRootHash: empty.toUpperCase(), newRootHash: empty, consistencyPath: [] }), /lowercase/);
  assert.throws(() => verifyConsistencyProof({ oldSize: 0, newSize: 1, oldRootHash: empty, newRootHash: empty, consistencyPath: ['00'] }), /lowercase/);
  assert.throws(() => verifyConsistencyProof({ oldSize: 1, newSize: 2, oldRootHash: empty, newRootHash: empty,
    consistencyPath: Array(4).fill(empty) }), /too many/);
});

test('history artifact binds its declared prefix to the same event sequence', () => {
  const source = bundle(7);
  const history = createHistory(source, 3);
  assert.equal(history.treeSize, 7);
  assert.equal(history.previousTreeSize, 3);
  assert.equal(verifyConsistencyProof({
    oldSize: history.previousTreeSize,
    newSize: history.treeSize,
    oldRootHash: history.previousRootHash,
    newRootHash: history.rootHash,
    consistencyPath: history.consistencyPath,
  }), true);
});
