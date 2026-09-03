'use strict';

const crypto = require('node:crypto');
const { canonicalize, sha256Hex } = require('./verify');

const KEY_TRANSITION_SCHEMA = 'mongbas-witness-key-transition/v1';
const TRANSITION_KEYS = ['schema', 'witnessID', 'electionID', 'electionContextHash', 'epochSeconds',
  'effectiveSequence', 'previousCheckpointHash', 'authorizedAt', 'oldPublicKeyDer', 'newPublicKeyDer',
  'oldSignature', 'newSignature'];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) throw new Error(`${label}: fields mismatch`);
}

function publicKeyDer(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('transition key must be Ed25519');
  return crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      Buffer.from(value, 'base64').toString('base64') !== value) throw new Error(`${label}: invalid canonical base64`);
  return Buffer.from(value, 'base64');
}

function unsignedTransition(transition) {
  const result = structuredClone(transition);
  delete result.oldSignature;
  delete result.newSignature;
  return result;
}

function transitionHash(transition) {
  return sha256Hex(canonicalize(transition));
}

function validateWitnessKeyTransition(transition, expected = {}) {
  exactKeys(transition, TRANSITION_KEYS, 'witness key transition');
  if (transition.schema !== KEY_TRANSITION_SCHEMA || !/^[A-Za-z0-9_.-]{1,128}$/.test(transition.witnessID) ||
      !/^[A-Za-z0-9_.-]{1,256}$/.test(transition.electionID) ||
      !/^[0-9a-f]{64}$/.test(transition.electionContextHash) ||
      !Number.isSafeInteger(transition.epochSeconds) || transition.epochSeconds < 1 || transition.epochSeconds > 86_400 ||
      !Number.isSafeInteger(transition.effectiveSequence) || transition.effectiveSequence < 2 ||
      !/^[0-9a-f]{64}$/.test(transition.previousCheckpointHash) ||
      new Date(transition.authorizedAt).toISOString() !== transition.authorizedAt ||
      transition.oldPublicKeyDer === transition.newPublicKeyDer) throw new Error('witness key transition: invalid fields');
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && transition[field] !== value) throw new Error(`witness key transition: ${field} mismatch`);
  }
  const oldKey = crypto.createPublicKey({ key: canonicalBase64(transition.oldPublicKeyDer, 'oldPublicKeyDer'), format: 'der', type: 'spki' });
  const newKey = crypto.createPublicKey({ key: canonicalBase64(transition.newPublicKeyDer, 'newPublicKeyDer'), format: 'der', type: 'spki' });
  if (oldKey.asymmetricKeyType !== 'ed25519' || newKey.asymmetricKeyType !== 'ed25519') throw new Error('transition keys must be Ed25519');
  const signedBytes = Buffer.from(canonicalize(unsignedTransition(transition)));
  if (!crypto.verify(null, signedBytes, oldKey, canonicalBase64(transition.oldSignature, 'oldSignature')) ||
      !crypto.verify(null, signedBytes, newKey, canonicalBase64(transition.newSignature, 'newSignature'))) {
    throw new Error('witness key transition: dual signature verification failed');
  }
  return true;
}

function createWitnessKeyTransition({ previousCheckpoint, oldPrivateKeyPem, newPrivateKeyPem,
  authorizedAt = new Date().toISOString() }) {
  if (previousCheckpoint?.schema !== 'mongbas-bulletin-board-checkpoint/v3' ||
      !Number.isSafeInteger(previousCheckpoint.sequence) || previousCheckpoint.sequence < 1) {
    throw new Error('witness key transition requires a v3 predecessor');
  }
  const oldPublicKeyDer = publicKeyDer(oldPrivateKeyPem);
  if (previousCheckpoint.witnessPublicKeyDer !== oldPublicKeyDer) throw new Error('old transition key does not sign the predecessor');
  const transition = {
    schema: KEY_TRANSITION_SCHEMA, witnessID: previousCheckpoint.witnessID, electionID: previousCheckpoint.electionID,
    electionContextHash: previousCheckpoint.electionContextHash, epochSeconds: previousCheckpoint.epochSeconds,
    effectiveSequence: previousCheckpoint.sequence + 1,
    previousCheckpointHash: sha256Hex(canonicalize(previousCheckpoint)), authorizedAt,
    oldPublicKeyDer, newPublicKeyDer: publicKeyDer(newPrivateKeyPem), oldSignature: '', newSignature: '',
  };
  const bytes = Buffer.from(canonicalize(unsignedTransition(transition)));
  transition.oldSignature = crypto.sign(null, bytes, crypto.createPrivateKey(oldPrivateKeyPem)).toString('base64');
  transition.newSignature = crypto.sign(null, bytes, crypto.createPrivateKey(newPrivateKeyPem)).toString('base64');
  validateWitnessKeyTransition(transition);
  return transition;
}

module.exports = { KEY_TRANSITION_SCHEMA, createWitnessKeyTransition, transitionHash, unsignedTransition,
  validateWitnessKeyTransition };
