'use strict';

const crypto = require('node:crypto');
const { canonicalize, sha256Hex } = require('./verify');

const CHECKPOINT_SCHEMA = 'mongbas-bulletin-board-checkpoint/v1';
const TRUST_SCHEMA = 'mongbas-witness-trust/v1';

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label}: unexpected or missing fields`);
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error(`${label}: invalid canonical base64`);
  }
  return Buffer.from(value, 'base64');
}

function unsignedCheckpoint(checkpoint) {
  const copy = structuredClone(checkpoint);
  delete copy.signature;
  return copy;
}

function checkpointHash(checkpoint) {
  return sha256Hex(canonicalize(checkpoint));
}

function publicKeyDer(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('witness signing key must be Ed25519');
  return crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

function createCheckpoint({ bundle, verification, witnessID, privateKeyPem, sequence, previousCheckpointHash = null, observedAt = new Date().toISOString() }) {
  if (!verification?.valid) throw new Error('cannot witness an invalid election bundle');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(witnessID || '')) throw new Error('invalid witnessID');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid checkpoint sequence');
  if (previousCheckpointHash !== null && !/^[0-9a-f]{64}$/.test(previousCheckpointHash)) throw new Error('invalid previousCheckpointHash');
  if (new Date(observedAt).toISOString() !== observedAt) throw new Error('observedAt must be canonical ISO-8601');
  const witnessPublicKeyDer = publicKeyDer(privateKeyPem);
  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    witnessID,
    witnessPublicKeyDer,
    sequence,
    previousCheckpointHash,
    observedAt,
    electionID: verification.electionID,
    bundleHash: verification.bundleHash,
    bulletinBoardRoot: bundle.bulletinBoard.root,
    ballotCount: verification.ballots,
    publishedAt: bundle.bulletinBoard.publishedAt,
    signature: '',
  };
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  checkpoint.signature = crypto.sign(null, Buffer.from(canonicalize(unsignedCheckpoint(checkpoint))), privateKey).toString('base64');
  return checkpoint;
}

function validateTrust(trust) {
  exactKeys(trust, ['schema', 'witnesses'], 'trust');
  if (trust.schema !== TRUST_SCHEMA || !Array.isArray(trust.witnesses) || trust.witnesses.length === 0) throw new Error('invalid witness trust document');
  const result = new Map();
  trust.witnesses.forEach((witness, index) => {
    exactKeys(witness, ['id', 'ed25519PublicKeyDer'], `trust.witnesses[${index}]`);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(witness.id) || result.has(witness.id)) throw new Error('invalid or duplicate trusted witness id');
    const key = crypto.createPublicKey({ key: canonicalBase64(witness.ed25519PublicKeyDer, `trust.witnesses[${index}].ed25519PublicKeyDer`), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('trusted witness key must be Ed25519');
    result.set(witness.id, { encoded: witness.ed25519PublicKeyDer, key });
  });
  return result;
}

function verifyCheckpointLog(lines, trust) {
  const trusted = validateTrust(trust);
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('checkpoint log is empty');
  let previousHash = null;
  lines.forEach((checkpoint, index) => {
    exactKeys(checkpoint, ['schema', 'witnessID', 'witnessPublicKeyDer', 'sequence', 'previousCheckpointHash', 'observedAt',
      'electionID', 'bundleHash', 'bulletinBoardRoot', 'ballotCount', 'publishedAt', 'signature'], `checkpoint[${index}]`);
    if (checkpoint.schema !== CHECKPOINT_SCHEMA || checkpoint.sequence !== index + 1 || checkpoint.previousCheckpointHash !== previousHash) {
      throw new Error(`checkpoint[${index}]: broken schema, sequence or hash chain`);
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(checkpoint.witnessID) || !/^[A-Za-z0-9_.-]{1,256}$/.test(checkpoint.electionID) ||
        !/^[0-9a-f]{64}$/.test(checkpoint.bundleHash) || !/^[0-9a-f]{64}$/.test(checkpoint.bulletinBoardRoot) ||
        !Number.isSafeInteger(checkpoint.ballotCount) || checkpoint.ballotCount < 1 || !Number.isSafeInteger(checkpoint.publishedAt) || checkpoint.publishedAt < 0 ||
        new Date(checkpoint.observedAt).toISOString() !== checkpoint.observedAt) throw new Error(`checkpoint[${index}]: invalid fields`);
    const witness = trusted.get(checkpoint.witnessID);
    if (!witness || witness.encoded !== checkpoint.witnessPublicKeyDer) throw new Error(`checkpoint[${index}]: untrusted witness key`);
    const signature = canonicalBase64(checkpoint.signature, `checkpoint[${index}].signature`);
    if (!crypto.verify(null, Buffer.from(canonicalize(unsignedCheckpoint(checkpoint))), witness.key, signature)) {
      throw new Error(`checkpoint[${index}]: invalid signature`);
    }
    previousHash = checkpointHash(checkpoint);
  });
  return { valid: true, checkpoints: lines.length, latestCheckpointHash: previousHash, latest: lines.at(-1) };
}

function parseCanonicalLog(text) {
  const rawLines = String(text).split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  if (!rawLines.length || rawLines.some(line => !line)) throw new Error('checkpoint log contains empty lines');
  return rawLines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch (error) { throw new Error(`checkpoint line ${index + 1}: invalid JSON: ${error.message}`); }
    if (canonicalize(value) !== line) throw new Error(`checkpoint line ${index + 1}: non-canonical JSON`);
    return value;
  });
}

module.exports = {
  CHECKPOINT_SCHEMA,
  TRUST_SCHEMA,
  checkpointHash,
  createCheckpoint,
  parseCanonicalLog,
  publicKeyDer,
  verifyCheckpointLog,
};
