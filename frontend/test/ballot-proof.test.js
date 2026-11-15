import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyVectorBallotProofBrowser } from '../src/utils/ballotProof.js';
import { verifyCountedSlot, zeroSlot } from '../src/utils/countedSlot.js';

// Same live Fabric bundle the standalone verifier pins (verifier/test/fixtures).
const bundle = JSON.parse(fs.readFileSync(new URL('../../verifier/test/fixtures/deniable-bundle-v6.json', import.meta.url), 'utf8'));

test('browser one-hot proof check accepts every published ballot', async () => {
  for (const ballot of bundle.ballots) {
    const report = await verifyVectorBallotProofBrowser(bundle.publicKey, ballot.ciphertextVector, ballot.validityProof);
    assert.equal(report.ok, true);
  }
});

test('browser one-hot proof check flags a swapped component', async () => {
  const ballot = bundle.ballots[0];
  const vector = [ballot.ciphertextVector[1], ballot.ciphertextVector[0], ballot.ciphertextVector[2]];
  const report = await verifyVectorBallotProofBrowser(bundle.publicKey, vector, ballot.validityProof);
  assert.equal(report.ok, false);
});

test('browser replays every counted slot chain from the zero slot', async () => {
  for (const ballot of bundle.ballots) {
    let previous = zeroSlot(ballot.ciphertextVector.length);
    for (const step of ballot.countedSlotChain) {
      assert.equal(await verifyCountedSlot({ pubKey: bundle.publicKey, electionID: bundle.configuration.electionID, nullifierHash: ballot.nullifierHash,
        visible: step.encryptedCandidateVector, previous, next: step.countedVector, proof: step.countedSlotProof }), true);
      previous = step.countedVector;
    }
  }
});
