'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  P, G, Q, modPow, generateTransportKeyPair, createContribution,
  finalizeTrusteeShare, finalizeTranscript,
} = require('../src/dkg');

function ceremony() {
  const ids = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
  const keyPairs = ids.map((id, offset) => generateTransportKeyPair(id, offset + 1));
  const participants = keyPairs.map(item => ({
    id: item.publicDescriptor.id,
    index: item.publicDescriptor.index,
    transportPublicKeyDer: item.publicDescriptor.transportPublicKeyDer,
    signingPublicKeyDer: item.publicDescriptor.signingPublicKeyDer,
  }));
  const ceremonyID = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const contributions = ids.map((dealerID, index) => createContribution({
    ceremonyID, dealerID, privateRecord: keyPairs[index].privateRecord, participants,
  }));
  const finalized = ids.map((trusteeID, index) => finalizeTrusteeShare({
    ceremonyID, trusteeID, privateRecord: keyPairs[index].privateRecord,
    participants, contributions,
  }));
  const transcript = finalizeTranscript({
    ceremonyID, participants, contributions,
    publicShares: finalized.map(item => item.publicShare),
  });
  return { ids, keyPairs, participants, ceremonyID, contributions, finalized, transcript };
}

function modInverse(value, modulus) {
  let [oldR, r] = [((value % modulus) + modulus) % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) throw new Error('inverse missing');
  return ((oldS % modulus) + modulus) % modulus;
}

test('three independent contributions produce one public key and consistent 2-of-3 shares', () => {
  const value = ceremony();
  assert.match(value.transcript.transcriptHash, /^[0-9a-f]{64}$/);
  assert.equal(value.transcript.publicShares.length, 3);
  const secret1 = BigInt(`0x${value.finalized[0].privateShare.scalar}`);
  const secret3 = BigInt(`0x${value.finalized[2].privateShare.scalar}`);
  const lambda1 = 3n * modInverse(2n, Q) % Q;
  const lambda3 = ((-1n % Q) + Q) % Q * modInverse(2n, Q) % Q;
  const reconstructed = (lambda1 * secret1 + lambda3 * secret3) % Q;
  assert.equal(modPow(G, reconstructed, P).toString(16), value.transcript.electionPublicKeyY);
});

test('no contribution or public transcript contains a scalar share or dealer secret', () => {
  const value = ceremony();
  const publicArtifacts = JSON.stringify({ contributions: value.contributions, transcript: value.transcript });
  assert.doesNotMatch(publicArtifacts, /"scalar"/);
  assert.doesNotMatch(publicArtifacts, /privateKey/i);
  assert.doesNotMatch(publicArtifacts, /privateShare/i);
});

test('a trustee cannot decrypt an envelope addressed to another trustee', () => {
  const value = ceremony();
  const tampered = structuredClone(value.contributions);
  const first = tampered[0].encryptedShares[0];
  const second = tampered[0].encryptedShares[1];
  [first.ephemeralPublicKeyDer, first.iv, first.ciphertext, first.tag] =
    [second.ephemeralPublicKeyDer, second.iv, second.ciphertext, second.tag];
  assert.throws(() => finalizeTrusteeShare({
    ceremonyID: value.ceremonyID,
    trusteeID: value.ids[0],
    privateRecord: value.keyPairs[0].privateRecord,
    participants: value.participants,
    contributions: tampered,
  }), /invalid DKG contribution signature/);
});

test('ciphertext, tag and Feldman commitment mutations fail closed', () => {
  const value = ceremony();
  for (const mutate of [
    contribution => { contribution.encryptedShares[0].ciphertext = Buffer.from('tampered').toString('base64'); },
    contribution => { contribution.encryptedShares[0].tag = Buffer.alloc(16, 7).toString('base64'); },
    contribution => { contribution.commitments.linear = contribution.commitments.constant; },
  ]) {
    const tampered = structuredClone(value.contributions);
    mutate(tampered[0]);
    assert.throws(() => finalizeTrusteeShare({
      ceremonyID: value.ceremonyID,
      trusteeID: value.ids[0],
      privateRecord: value.keyPairs[0].privateRecord,
      participants: value.participants,
      contributions: tampered,
    }), /invalid DKG contribution signature/);
  }
});

test('a contribution signed by a different trustee is rejected', () => {
  const value = ceremony();
  const forged = createContribution({
    ceremonyID: value.ceremonyID,
    dealerID: value.ids[1],
    privateRecord: value.keyPairs[1].privateRecord,
    participants: value.participants,
  });
  forged.dealerID = value.ids[0];
  const contributions = structuredClone(value.contributions);
  contributions[0] = forged;
  assert.throws(() => finalizeTrusteeShare({
    ceremonyID: value.ceremonyID,
    trusteeID: value.ids[0],
    privateRecord: value.keyPairs[0].privateRecord,
    participants: value.participants,
    contributions,
  }), /invalid DKG contribution signature/);
});

test('missing, duplicate and wrong-ceremony contributions are rejected', () => {
  const value = ceremony();
  const args = {
    ceremonyID: value.ceremonyID,
    trusteeID: value.ids[0],
    privateRecord: value.keyPairs[0].privateRecord,
    participants: value.participants,
  };
  assert.throws(() => finalizeTrusteeShare({ ...args, contributions: value.contributions.slice(0, 2) }), /every trustee/);
  assert.throws(() => finalizeTrusteeShare({ ...args, contributions: [value.contributions[0], value.contributions[0], value.contributions[2]] }), /every trustee/);
  const wrong = structuredClone(value.contributions);
  wrong[0].ceremonyID = 'different';
  assert.throws(() => finalizeTrusteeShare({ ...args, contributions: wrong }), /invalid DKG contribution/);
});

test('transcript rejects forged or relabelled public trustee shares', () => {
  const value = ceremony();
  const publicShares = value.finalized.map(item => structuredClone(item.publicShare));
  publicShares[0].publicKeyY = publicShares[1].publicKeyY;
  assert.throws(() => finalizeTranscript({
    ceremonyID: value.ceremonyID, participants: value.participants,
    contributions: value.contributions, publicShares,
  }), /aggregate public share mismatch/);
});
