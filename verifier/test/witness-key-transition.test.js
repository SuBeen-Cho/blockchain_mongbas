'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createOpeningCheckpoint } = require('../src/witness');
const { createWitnessKeyTransition, transitionHash, validateWitnessKeyTransition } = require('../src/witness-key-transition');

function pem(pair) { return pair.privateKey.export({ format: 'pem', type: 'pkcs8' }); }

test('witness transition is bound to predecessor, context and both Ed25519 keys', () => {
  const oldPair = crypto.generateKeyPairSync('ed25519'), newPair = crypto.generateKeyPairSync('ed25519');
  const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'a'.repeat(64),
    epochSeconds: 300, witnessID: 'observer', privateKeyPem: pem(oldPair), observedAt: '2026-09-04T00:00:00.000Z' });
  const transition = createWitnessKeyTransition({ previousCheckpoint: opening, oldPrivateKeyPem: pem(oldPair),
    newPrivateKeyPem: pem(newPair), authorizedAt: '2026-09-04T00:01:00.000Z' });
  assert.equal(validateWitnessKeyTransition(transition, { effectiveSequence: 2,
    previousCheckpointHash: require('../src/witness').checkpointHash(opening) }), true);
  assert.match(transitionHash(transition), /^[0-9a-f]{64}$/);
  for (const field of ['electionContextHash', 'epochSeconds', 'effectiveSequence', 'previousCheckpointHash', 'authorizedAt']) {
    const mutated = structuredClone(transition);
    if (field === 'epochSeconds') mutated[field]++;
    else if (field === 'effectiveSequence') mutated[field]++;
    else if (field === 'authorizedAt') mutated[field] = '2026-09-04T00:02:00.000Z';
    else mutated[field] = (mutated[field][0] === 'a' ? 'b' : 'a') + mutated[field].slice(1);
    assert.throws(() => validateWitnessKeyTransition(mutated), /verification failed/);
  }
});

test('transition rejects unilateral rotation and wrong predecessor key', () => {
  const oldPair = crypto.generateKeyPairSync('ed25519'), newPair = crypto.generateKeyPairSync('ed25519');
  const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'a'.repeat(64),
    witnessID: 'observer', privateKeyPem: pem(oldPair) });
  const transition = createWitnessKeyTransition({ previousCheckpoint: opening, oldPrivateKeyPem: pem(oldPair),
    newPrivateKeyPem: pem(newPair) });
  transition.newSignature = transition.oldSignature;
  assert.throws(() => validateWitnessKeyTransition(transition), /verification failed/);
  const unrelated = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => createWitnessKeyTransition({ previousCheckpoint: opening, oldPrivateKeyPem: pem(unrelated),
    newPrivateKeyPem: pem(newPair) }), /does not sign/);
});
