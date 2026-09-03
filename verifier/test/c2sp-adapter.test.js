'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  createSignedCheckpoint,
  createWitnessRequest,
  createC2spSubmissionFromV3Log,
  parseAndVerifySignedCheckpoint,
} = require('../src/c2sp-adapter');
const { createOpeningCheckpoint, publicKeyDer, TRUST_SCHEMA } = require('../src/witness');

function pem(pair) {
  return pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
}

test('C2SP adapter signs and strictly verifies a three-line checkpoint note', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const rootHash = crypto.createHash('sha256').update('root').digest('hex');
  const note = createSignedCheckpoint({ origin, treeSize: 17, rootHash, privateKeyPem: pem(pair) });
  const verified = parseAndVerifySignedCheckpoint(note, {
    origin,
    publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  });
  assert.deepEqual(verified, { origin, treeSize: 17, rootHash, validSignatures: 1 });
  assert.match(note, new RegExp(`^${origin}\\n17\\n`));
  assert.equal(note.split('\n')[3], '');

  const mutated = note.replace('\n17\n', '\n18\n');
  assert.throws(() => parseAndVerifySignedCheckpoint(mutated, {
    origin, publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }), /signature/);
});

test('C2SP adapter rejects wrong trust, malformed note fields and excessive signatures', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const rootHash = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const note = createSignedCheckpoint({ origin, treeSize: 0, rootHash, privateKeyPem: pem(pair) });
  assert.throws(() => parseAndVerifySignedCheckpoint(note, {
    origin: 'mongbas.example/cast-history/election-b',
    publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }), /origin/);
  assert.throws(() => parseAndVerifySignedCheckpoint(note, {
    origin, publicKeyDer: other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }), /trusted signature/);
  assert.throws(() => createSignedCheckpoint({ origin: 'bad origin', treeSize: 0, rootHash, privateKeyPem: pem(pair) }), /origin/);
  assert.throws(() => createSignedCheckpoint({ origin, treeSize: -1, rootHash, privateKeyPem: pem(pair) }), /tree size/);
  const signature = note.trimEnd().split('\n').at(-1);
  assert.throws(() => parseAndVerifySignedCheckpoint(`${note.trimEnd()}\n${Array(16).fill(signature).join('\n')}\n`, {
    origin, publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }), /too many signatures/);
});

test('C2SP witness request carries the old size and RFC-style consistency nodes', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const note = createSignedCheckpoint({ origin: 'mongbas.example/cast-history/election-a', treeSize: 9,
    rootHash: 'cd'.repeat(32), privateKeyPem: pem(pair) });
  const path = ['01'.repeat(32), 'fe'.repeat(32)];
  const request = createWitnessRequest({ oldSize: 5, consistencyPath: path, signedCheckpoint: note });
  assert.equal(request, `old 5\n${Buffer.from(path[0], 'hex').toString('base64')}\n${Buffer.from(path[1], 'hex').toString('base64')}\n\n${note}`);
  assert.throws(() => createWitnessRequest({ oldSize: 10, consistencyPath: path, signedCheckpoint: note }), /old size/);
  assert.throws(() => createWitnessRequest({ oldSize: 0, consistencyPath: path, signedCheckpoint: note }), /empty/);
  assert.throws(() => createWitnessRequest({ oldSize: 5, consistencyPath: Array(64).fill(path[0]), signedCheckpoint: note }), /63/);
});

test('C2SP submission is derived only from a verified v3 log with a separate operator key', () => {
  const witness = crypto.generateKeyPairSync('ed25519');
  const operator = crypto.generateKeyPairSync('ed25519');
  const witnessPem = pem(witness);
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(witnessPem) }] };
  const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'ab'.repeat(32),
    epochSeconds: 300, witnessID: 'observer', privateKeyPem: witnessPem, observedAt: '2026-09-04T00:00:00.000Z' });
  const submission = createC2spSubmissionFromV3Log({ origin: 'mongbas.example/cast-history/election-a',
    checkpointLog: [opening], trust, logPrivateKeyPem: pem(operator) });
  assert.equal(submission.treeSize, 0);
  assert.equal(submission.rootHash, crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.equal(submission.sourceSequence, 1);
  assert.match(submission.witnessRequest, /^old 0\n\nmongbas\.example\/cast-history\/election-a\n0\n/);
  assert.throws(() => createC2spSubmissionFromV3Log({ origin: 'mongbas.example/cast-history/election-a',
    checkpointLog: [opening], trust, logPrivateKeyPem: pem(operator), previousSignedCheckpoint: submission.signedCheckpoint }),
  /opening must not replace/);
  assert.throws(() => createC2spSubmissionFromV3Log({ origin: 'mongbas.example/cast-history/election-a',
    checkpointLog: [opening], trust, logPrivateKeyPem: witnessPem }), /must be distinct/);
  const altered = structuredClone(opening);
  altered.history.rootHash = '00'.repeat(32);
  assert.throws(() => createC2spSubmissionFromV3Log({ origin: 'mongbas.example/cast-history/election-a',
    checkpointLog: [altered], trust, logPrivateKeyPem: pem(operator) }), /empty opening|signature/);
});
