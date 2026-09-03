'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  createSignedCheckpoint,
  createWitnessRequest,
  createC2spSubmissionFromV3Log,
  parseAndVerifySignedCheckpoint,
} = require('../src/c2sp-adapter');
const { createOpeningCheckpoint, publicKeyDer, TRUST_SCHEMA } = require('../src/witness');
const { canonicalize } = require('../src/verify');

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

test('C2SP CLI atomically persists operator state before publishing non-overwriting requests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-c2sp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const witness = crypto.generateKeyPairSync('ed25519');
  const operator = crypto.generateKeyPairSync('ed25519');
  const witnessPem = pem(witness);
  const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'ab'.repeat(32),
    epochSeconds: 300, witnessID: 'observer', privateKeyPem: witnessPem, observedAt: '2026-09-04T00:00:00.000Z' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(witnessPem) }] };
  const logFile = path.join(directory, 'checkpoints.jsonl');
  const trustFile = path.join(directory, 'trust.json');
  const keyFile = path.join(directory, 'operator.pem');
  const stateDirectory = path.join(directory, 'state');
  fs.writeFileSync(logFile, `${canonicalize(opening)}\n`);
  fs.writeFileSync(trustFile, canonicalize(trust));
  fs.writeFileSync(keyFile, pem(operator), { mode: 0o600 });
  const cli = path.join(__dirname, '../bin/mongbas-c2sp.js');
  const invoke = output => spawnSync(process.execPath,
    [cli, 'publish', logFile, trustFile, 'mongbas.example/cast-history/election-a', keyFile, stateDirectory, output],
    { encoding: 'utf8' });
  const firstOutput = path.join(directory, 'request-1.txt');
  const first = invoke(firstOutput);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /treeSize=0 sourceSequence=1/);
  const stateFile = path.join(stateDirectory, 'checkpoint.note');
  const persisted = fs.readFileSync(stateFile, 'utf8');
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(stateDirectory).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(firstOutput, 'utf8'), /^old 0\n\n/);

  const secondOutput = path.join(directory, 'request-2.txt');
  const retry = invoke(secondOutput);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), persisted);
  assert.equal(fs.readFileSync(secondOutput, 'utf8'), fs.readFileSync(firstOutput, 'utf8'));
  const overwrite = invoke(secondOutput);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /already exists/);
  assert.equal(fs.readdirSync(stateDirectory).sort().join(','), 'checkpoint.note');
});

test('verifier package explicitly allowlists runtime files and every CLI is locked', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.files, ['bin/', 'src/', 'schema/', 'reference/*.py', 'README.md']);
  assert.deepEqual(lock.packages[''].bin, Object.fromEntries(Object.entries(manifest.bin).sort()));
  assert.ok(manifest.bin['mongbas-c2sp']);
});
