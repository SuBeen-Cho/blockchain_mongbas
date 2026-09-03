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
  verifyWitnessCosignatures,
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

function appendCosignature(note, name, pair, timestamp) {
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  const raw = publicDer.subarray(-32);
  const id = crypto.createHash('sha256').update(name).update('\n').update(Buffer.from([0x04])).update(raw).digest().subarray(0, 4);
  const body = note.slice(0, note.lastIndexOf('\n\n') + 1);
  const message = Buffer.from(`cosignature/v1\ntime ${timestamp}\n${body}`, 'utf8');
  const encoded = Buffer.alloc(76);
  id.copy(encoded, 0);
  encoded.writeBigUInt64BE(BigInt(timestamp), 4);
  crypto.sign(null, message, pair.privateKey).copy(encoded, 12);
  return `${note.trimEnd()}\n— ${name} ${encoded.toString('base64')}\n`;
}

test('timestamped C2SP witness cosignatures satisfy only an explicit distinct k-of-n policy', () => {
  const operator = crypto.generateKeyPairSync('ed25519');
  const first = crypto.generateKeyPairSync('ed25519');
  const second = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  let note = createSignedCheckpoint({ origin, treeSize: 2, rootHash: 'ab'.repeat(32), privateKeyPem: pem(operator) });
  note = appendCosignature(note, 'witness.example/first', first, 2_000);
  note = appendCosignature(note, 'witness.example/second', second, 2_001);
  const witnesses = [first, second].map((pair, index) => ({ id: `w${index + 1}`,
    name: `witness.example/${index === 0 ? 'first' : 'second'}`,
    publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  assert.deepEqual(verifyWitnessCosignatures(note, { witnesses, quorum: 2, nowSeconds: 2_100 }), {
    valid: true, quorum: 2, acceptedWitnesses: ['w1', 'w2'], timestamps: { w1: 2_000, w2: 2_001 },
  });
  assert.throws(() => verifyWitnessCosignatures(note, { witnesses: [witnesses[0]], quorum: 1, nowSeconds: 1_000 }), /future/);
  const zeroTimestamp = appendCosignature(createSignedCheckpoint({ origin, treeSize: 2, rootHash: 'ab'.repeat(32),
    privateKeyPem: pem(operator) }), 'witness.example/first', first, 0);
  assert.throws(() => verifyWitnessCosignatures(zeroTimestamp, { witnesses: [witnesses[0]], quorum: 1, nowSeconds: 2_100 }), /timestamp/);
  assert.throws(() => verifyWitnessCosignatures(note, { witnesses: [witnesses[0]], quorum: 1, nowSeconds: 2_100,
    maxFutureSkewSeconds: 3_601 }), /one hour/);
  assert.throws(() => verifyWitnessCosignatures(note, { witnesses: [witnesses[0], { ...witnesses[1], publicKeyDer: witnesses[0].publicKeyDer }],
    quorum: 2, nowSeconds: 2_100 }), /duplicate/);
});

test('known invalid, duplicate and insufficient C2SP cosignatures fail closed', () => {
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const base = createSignedCheckpoint({ origin, treeSize: 2, rootHash: 'cd'.repeat(32), privateKeyPem: pem(operator) });
  const signed = appendCosignature(base, 'witness.example/one', witness, 2_000);
  const policy = [{ id: 'one', name: 'witness.example/one',
    publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }];
  assert.throws(() => verifyWitnessCosignatures(`${signed.trimEnd()}\n${signed.trimEnd().split('\n').at(-1)}\n`,
    { witnesses: policy, quorum: 1, nowSeconds: 2_100 }), /duplicate/);
  const payload = signed.trimEnd().split(' ').at(-1);
  const bytes = Buffer.from(payload, 'base64');
  bytes[bytes.length - 1] ^= 1;
  const broken = signed.replace(payload, bytes.toString('base64'));
  assert.throws(() => verifyWitnessCosignatures(broken, { witnesses: policy, quorum: 1, nowSeconds: 2_100 }), /invalid.*cosignature/);
  const unknown = [{ id: 'other', name: 'witness.example/other', publicKeyDer: policy[0].publicKeyDer }];
  assert.throws(() => verifyWitnessCosignatures(signed, { witnesses: unknown, quorum: 1, nowSeconds: 2_100 }), /quorum not met/);
});

test('C2SP CLI verifies both the pinned log signature and witness quorum', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-c2sp-verify-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const note = appendCosignature(createSignedCheckpoint({ origin, treeSize: 1, rootHash: 'ef'.repeat(32),
    privateKeyPem: pem(operator) }), 'witness.example/one', witness, Math.floor(Date.now() / 1000));
  const noteFile = path.join(directory, 'checkpoint.note');
  const logTrustFile = path.join(directory, 'log-trust.json');
  const policyFile = path.join(directory, 'witness-policy.json');
  fs.writeFileSync(noteFile, note);
  fs.writeFileSync(logTrustFile, JSON.stringify({ origin,
    publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  fs.writeFileSync(policyFile, JSON.stringify({ schema: 'mongbas-c2sp-witness-policy/v1', quorum: 1,
    witnesses: [{ id: 'one', name: 'witness.example/one',
      publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] }));
  const cli = path.join(__dirname, '../bin/mongbas-c2sp.js');
  const verified = spawnSync(process.execPath, [cli, 'verify-cosignatures', noteFile, logTrustFile, policyFile], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /VALID C2SP CHECKPOINT/);
  assert.match(verified.stdout, /WITNESS QUORUM: 1\/1 ids=one/);
  const badPolicy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  badPolicy.quorum = 2;
  fs.writeFileSync(policyFile, JSON.stringify(badPolicy));
  const rejected = spawnSync(process.execPath, [cli, 'verify-cosignatures', noteFile, logTrustFile, policyFile], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
});
