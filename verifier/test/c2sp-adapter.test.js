'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  advanceCheckpointAnchor,
  createSignedCheckpoint,
  createWitnessRequest,
  createC2spSubmissionFromV3Log,
  parseAndVerifySignedCheckpoint,
  submitWitnessRequest,
  verifyWitnessCosignatures,
  verifyCheckpointAnchorState,
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

function cosignatureLine(note, name, pair, timestamp) {
  return `${appendCosignature(note, name, pair, timestamp).trimEnd().split('\n').at(-1)}\n`;
}

test('C2SP witness transport posts an exact bounded request and accepts only a verified quorum', async () => {
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const signedCheckpoint = createSignedCheckpoint({ origin, treeSize: 0,
    rootHash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'), privateKeyPem: pem(operator) });
  const request = createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint });
  const timestamp = Math.floor(Date.now() / 1000);
  const line = cosignatureLine(signedCheckpoint, 'witness.example/one', witness, timestamp);
  const calls = [];
  const result = await submitWitnessRequest({ endpoint: 'https://witness.example/add-checkpoint', request,
    signedCheckpoint, logTrust: { origin,
      publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    witnessPolicy: { quorum: 1, witnesses: [{ id: 'one', name: 'witness.example/one',
      publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(line, { status: 200, headers: { 'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(line)) } });
    } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://witness.example/add-checkpoint');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['content-type'], 'application/octet-stream');
  assert.equal(calls[0].options.body, request);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(result.quorumResult.acceptedWitnesses, ['one']);
  assert.equal(result.cosignedCheckpoint, `${signedCheckpoint.trimEnd()}\n${line}`);
});

test('C2SP witness transport rejects unsafe endpoints without making a request', async () => {
  const invalid = ['http://witness.example/add-checkpoint', 'https://user@witness.example/add-checkpoint',
    'https://witness.example/add-checkpoint?x=1', 'https://witness.example/checkpoint'];
  let calls = 0;
  for (const endpoint of invalid) {
    await assert.rejects(submitWitnessRequest({ endpoint, request: '', signedCheckpoint: '', logTrust: {},
      witnessPolicy: {}, fetchImpl: async () => { calls += 1; } }), /HTTPS add-checkpoint/);
  }
  assert.equal(calls, 0);
});

test('C2SP witness transport validates trust, policy and exact request before network access', async () => {
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const signedCheckpoint = createSignedCheckpoint({ origin, treeSize: 0,
    rootHash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'), privateKeyPem: pem(operator) });
  const request = createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint });
  const trust = { origin, publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const policy = { quorum: 1, witnesses: [{ id: 'one', name: 'witness.example/one',
    publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('network must not be reached'); };
  const base = { endpoint: 'https://witness.example/add-checkpoint', request, signedCheckpoint,
    logTrust: trust, witnessPolicy: policy, fetchImpl };
  await assert.rejects(submitWitnessRequest({ ...base,
    logTrust: { ...trust, publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') } }),
  /trusted signature/);
  await assert.rejects(submitWitnessRequest({ ...base, witnessPolicy: { ...policy, quorum: 2 } }), /valid k-of-n/);
  await assert.rejects(submitWitnessRequest({ ...base, request: request.replace(/^old 0/, 'old 00') }), /request/);
  await assert.rejects(submitWitnessRequest({ ...base, request: `old 0\n${Buffer.alloc(32).toString('base64')}\n\n${signedCheckpoint}` }),
    /empty/);
  await assert.rejects(submitWitnessRequest({ ...base, request: `garbage\n\n${signedCheckpoint}` }), /request/);
  assert.equal(calls, 0);
});

test('C2SP witness transport fails closed on conflicts, status and bounded response violations', async () => {
  const operator = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const signedCheckpoint = createSignedCheckpoint({ origin, treeSize: 0,
    rootHash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'), privateKeyPem: pem(operator) });
  const request = createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint });
  const common = { endpoint: 'https://witness.example/add-checkpoint', request, signedCheckpoint,
    logTrust: { origin, publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') },
    witnessPolicy: { quorum: 1, witnesses: [{ id: 'unused', name: 'witness.example/unused',
      publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] } };
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response('17\n', {
    status: 409, headers: { 'content-type': 'text/x.tlog.size' } }) }), /conflict at tree size 17/);
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response('17', {
    status: 409, headers: { 'content-type': 'text/x.tlog.size' } }) }), /malformed conflict/);
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response('failure', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response('x', {
    status: 200, headers: { 'content-length': '65537' } }) }), /size limit/);
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); controller.close(); },
  }), { status: 200 }) }), /size limit/);
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response(Buffer.from([0xff]), { status: 200 }) }),
    /encoded data|encoding|UTF-8/i);
  await assert.rejects(submitWitnessRequest({ ...common, fetchImpl: async () => new Response('not-a-signature\n', { status: 200 }) }),
    /malformed or excessive/);
});

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

test('external C2SP anchor advances only through a quorum-signed consistency proof', () => {
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/anchor';
  const now = Math.floor(Date.now() / 1000);
  const policy = { witnesses: [{ id: 'one', name: 'witness.example/one',
    publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }], quorum: 1 };
  const trust = { origin, publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const hash = value => crypto.createHash('sha256').update(value).digest();
  const left = hash(Buffer.concat([Buffer.from([0]), Buffer.from('one')]));
  const right = hash(Buffer.concat([Buffer.from([0]), Buffer.from('two')]));
  const root = hash(Buffer.concat([Buffer.from([1]), left, right]));
  const firstSigned = createSignedCheckpoint({ origin, treeSize: 1, rootHash: left.toString('hex'), privateKeyPem: pem(operator) });
  const firstCosigned = appendCosignature(firstSigned, 'witness.example/one', witness, now);
  const first = advanceCheckpointAnchor({ cosignedCheckpoint: firstCosigned,
    request: createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint: firstSigned }),
    logTrust: trust, witnessPolicy: policy });
  assert.equal(first.anchor.treeSize, 1);
  assert.deepEqual(first.quorumResult.acceptedWitnesses, ['one']);

  const secondSigned = createSignedCheckpoint({ origin, treeSize: 2, rootHash: root.toString('hex'), privateKeyPem: pem(operator) });
  const secondCosigned = appendCosignature(secondSigned, 'witness.example/one', witness, now);
  const secondRequest = createWitnessRequest({ oldSize: 1, consistencyPath: [right.toString('hex')], signedCheckpoint: secondSigned });
  const second = advanceCheckpointAnchor({ cosignedCheckpoint: secondCosigned, request: secondRequest,
    logTrust: trust, witnessPolicy: policy, previousAnchor: first.anchor });
  assert.equal(second.anchor.treeSize, 2);
  assert.equal(second.anchor.rootHash, root.toString('hex'));

  assert.throws(() => advanceCheckpointAnchor({ cosignedCheckpoint: firstCosigned,
    request: createWitnessRequest({ oldSize: 1, consistencyPath: [], signedCheckpoint: firstSigned }),
    logTrust: trust, witnessPolicy: policy, previousAnchor: second.anchor }), /rollback/);
  const forkSigned = createSignedCheckpoint({ origin, treeSize: 2, rootHash: 'ab'.repeat(32), privateKeyPem: pem(operator) });
  const forkCosigned = appendCosignature(forkSigned, 'witness.example/one', witness, now);
  assert.throws(() => advanceCheckpointAnchor({ cosignedCheckpoint: forkCosigned,
    request: createWitnessRequest({ oldSize: 2, consistencyPath: [], signedCheckpoint: forkSigned }),
    logTrust: trust, witnessPolicy: policy, previousAnchor: second.anchor }), /fork/);
  const thirdSigned = createSignedCheckpoint({ origin, treeSize: 3, rootHash: 'cd'.repeat(32), privateKeyPem: pem(operator) });
  const thirdCosigned = appendCosignature(thirdSigned, 'witness.example/one', witness, now);
  assert.throws(() => advanceCheckpointAnchor({ cosignedCheckpoint: thirdCosigned,
    request: createWitnessRequest({ oldSize: 2, consistencyPath: ['ef'.repeat(32)], signedCheckpoint: thirdSigned }),
    logTrust: trust, witnessPolicy: policy, previousAnchor: second.anchor }), /consistency proof/);
});

test('C2SP anchor CLI requires explicit initialization and preserves state on rollback', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-c2sp-anchor-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/anchor-cli';
  const now = Math.floor(Date.now() / 1000);
  const trust = { origin, publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const policy = { schema: 'mongbas-c2sp-witness-policy/v1', quorum: 1, witnesses: [{ id: 'one', name: 'witness.example/one',
    publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] };
  const leaf = crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from('one')])).digest('hex');
  const signed = createSignedCheckpoint({ origin, treeSize: 1, rootHash: leaf, privateKeyPem: pem(operator) });
  const cosigned = appendCosignature(signed, 'witness.example/one', witness, now);
  const files = { request: path.join(directory, 'request'), note: path.join(directory, 'note'),
    trust: path.join(directory, 'trust'), policy: path.join(directory, 'policy'), anchor: path.join(directory, 'anchor.json') };
  fs.writeFileSync(files.request, createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint: signed }));
  fs.writeFileSync(files.note, cosigned); fs.writeFileSync(files.trust, JSON.stringify(trust));
  fs.writeFileSync(files.policy, JSON.stringify(policy));
  const cli = path.join(__dirname, '../bin/mongbas-c2sp.js');
  const beforeInit = spawnSync(process.execPath, [cli, 'advance-anchor', files.request, files.note, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(beforeInit.status, 1); assert.match(beforeInit.stderr, /initialize it explicitly/);
  const initialized = spawnSync(process.execPath, [cli, 'initialize-anchor', files.request, files.note, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr); assert.equal(fs.statSync(files.anchor).mode & 0o777, 0o600);
  const original = fs.readFileSync(files.anchor, 'utf8');
  const duplicateInit = spawnSync(process.execPath, [cli, 'initialize-anchor', files.request, files.note, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(duplicateInit.status, 1); assert.match(duplicateInit.stderr, /already exists/);
  const matching = spawnSync(process.execPath, [cli, 'check-anchor', files.note, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(matching.status, 0, matching.stderr); assert.match(matching.stdout, /C2SP ANCHOR MATCH/);
  const anchor = JSON.parse(fs.readFileSync(files.anchor, 'utf8'));
  assert.equal(verifyCheckpointAnchorState({ cosignedCheckpoint: cosigned, logTrust: trust,
    witnessPolicy: policy, anchor }).valid, true);
  const rolledBackSigned = createSignedCheckpoint({ origin, treeSize: 0, rootHash: crypto.createHash('sha256').update('').digest('hex'), privateKeyPem: pem(operator) });
  const rolledBack = appendCosignature(rolledBackSigned, 'witness.example/one', witness, now);
  assert.throws(() => verifyCheckpointAnchorState({ cosignedCheckpoint: rolledBack, logTrust: trust,
    witnessPolicy: policy, anchor }), /database rollback/);
  const rollback = spawnSync(process.execPath, [cli, 'advance-anchor', files.request, files.note, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(rollback.status, 1); assert.match(rollback.stderr, /does not start at previous size/);
  assert.equal(fs.readFileSync(files.anchor, 'utf8'), original);
  assert.equal(fs.existsSync(`${files.anchor}.lock`), false);
});

test('Linux witness startup preflight rejects a SQLite checkpoint behind its external anchor', t => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('python3 is unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-witness-db-preflight-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const operator = crypto.generateKeyPairSync('ed25519'), witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/sqlite-preflight', now = Math.floor(Date.now() / 1000);
  const trust = { origin, publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const policy = { schema: 'mongbas-c2sp-witness-policy/v1', quorum: 1, witnesses: [{ id: 'one', name: 'witness.example/one',
    publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] };
  const root = crypto.createHash('sha256').update('current').digest('hex');
  const signed = createSignedCheckpoint({ origin, treeSize: 2, rootHash: root, privateKeyPem: pem(operator) });
  const current = appendCosignature(signed, 'witness.example/one', witness, now);
  const anchor = advanceCheckpointAnchor({ cosignedCheckpoint: current,
    request: createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint: signed }),
    logTrust: trust, witnessPolicy: policy }).anchor;
  const files = { db: path.join(directory, 'witness.db'), note: path.join(directory, 'checkpoint.note'),
    trust: path.join(directory, 'trust.json'), policy: path.join(directory, 'policy.json'), anchor: path.join(directory, 'anchor.json') };
  fs.writeFileSync(files.note, current); fs.writeFileSync(files.trust, JSON.stringify(trust));
  fs.writeFileSync(files.policy, JSON.stringify(policy)); fs.writeFileSync(files.anchor, JSON.stringify(anchor));
  const sqlite = 'import sqlite3,sys\n' +
    'db,origin,note=sys.argv[1:]\ncon=sqlite3.connect(db)\n' +
    'con.executescript("CREATE TABLE logs(logID BLOB PRIMARY KEY, origin STRING NOT NULL, vkey STRING NOT NULL, contact STRING, qpd FLOAT64, disabled BOOL); CREATE TABLE chkpts(logID BLOB PRIMARY KEY, chkpt BLOB);")\n' +
    'key=b"log-id"\ncon.execute("INSERT INTO logs(logID,origin,vkey) VALUES(?,?,?)",(key,origin,"unused"))\n' +
    'con.execute("INSERT INTO chkpts(logID,chkpt) VALUES(?,?)",(key,open(note,"rb").read()))\ncon.commit()\n';
  assert.equal(spawnSync('python3', ['-c', sqlite, files.db, origin, files.note], { encoding: 'utf8' }).status, 0);
  const preflight = path.join(__dirname, '../../deploy/linux/witness-anchor-preflight.sh');
  const accepted = spawnSync(preflight, [files.db, origin, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /PREFLIGHT PASSED/);
  const launcher = path.join(__dirname, '../../deploy/linux/witness-anchored-start.sh');
  const launcherSource = fs.readFileSync(launcher, 'utf8');
  assert.match(launcherSource, /expected_command_sha256/);
  assert.match(launcherSource, /sha256sum/);
  assert.match(launcherSource, /database changed during startup preflight/);
  assert.match(launcherSource, /state_fingerprint/);
  assert.match(launcherSource, /-wal/);
  assert.match(launcherSource, /-shm/);
  const touchHash = spawnSync('sha256sum', ['/usr/bin/touch'], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
  const sidecarTarget = path.join(directory, 'sidecar-target');
  fs.writeFileSync(sidecarTarget, 'not sqlite state');
  fs.symlinkSync(sidecarTarget, `${files.db}-wal`);
  const sidecarMarker = path.join(directory, 'must-not-run-sidecar');
  const sidecarRejected = spawnSync(launcher,
    [files.db, origin, files.trust, files.policy, files.anchor, touchHash, '/usr/bin/touch', sidecarMarker], { encoding: 'utf8' });
  assert.equal(sidecarRejected.status, 1); assert.match(sidecarRejected.stderr, /sidecar must not be a symlink/);
  assert.equal(fs.existsSync(sidecarMarker), false);
  fs.unlinkSync(`${files.db}-wal`);
  const startedMarker = path.join(directory, 'started');
  const started = spawnSync(launcher,
    [files.db, origin, files.trust, files.policy, files.anchor, touchHash, '/usr/bin/touch', startedMarker], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr); assert.equal(fs.existsSync(startedMarker), true);
  const unpinnedMarker = path.join(directory, 'must-not-run-unpinned');
  const unpinned = spawnSync(launcher,
    [files.db, origin, files.trust, files.policy, files.anchor, '0'.repeat(64), '/usr/bin/touch', unpinnedMarker], { encoding: 'utf8' });
  assert.equal(unpinned.status, 1); assert.match(unpinned.stderr, /does not match the pinned executable/);
  assert.equal(fs.existsSync(unpinnedMarker), false);
  const oldSigned = createSignedCheckpoint({ origin, treeSize: 1, rootHash: crypto.createHash('sha256').update('old').digest('hex'), privateKeyPem: pem(operator) });
  fs.writeFileSync(files.note, appendCosignature(oldSigned, 'witness.example/one', witness, now));
  const replace = 'import sqlite3,sys\ncon=sqlite3.connect(sys.argv[1])\ncon.execute("UPDATE chkpts SET chkpt=?",(open(sys.argv[2],"rb").read(),))\ncon.commit()\n';
  assert.equal(spawnSync('python3', ['-c', replace, files.db, files.note], { encoding: 'utf8' }).status, 0);
  const rejected = spawnSync(preflight, [files.db, origin, files.trust, files.policy, files.anchor], { encoding: 'utf8' });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /database rollback detected/);
  const rejectedMarker = path.join(directory, 'must-not-start');
  const blockedStart = spawnSync(launcher,
    [files.db, origin, files.trust, files.policy, files.anchor, touchHash, '/usr/bin/touch', rejectedMarker], { encoding: 'utf8' });
  assert.equal(blockedStart.status, 1); assert.match(blockedStart.stderr, /database rollback detected/);
  assert.equal(fs.existsSync(rejectedMarker), false);
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

test('C2SP submit CLI fails closed before creating output for an unsafe endpoint', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-c2sp-submit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const note = createSignedCheckpoint({ origin, treeSize: 0,
    rootHash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'), privateKeyPem: pem(operator) });
  const request = createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint: note });
  const requestFile = path.join(directory, 'request.txt');
  const noteFile = path.join(directory, 'checkpoint.note');
  const logTrustFile = path.join(directory, 'log-trust.json');
  const policyFile = path.join(directory, 'witness-policy.json');
  const outputFile = path.join(directory, 'cosigned.note');
  fs.writeFileSync(requestFile, request);
  fs.writeFileSync(noteFile, note);
  fs.writeFileSync(logTrustFile, JSON.stringify({ origin,
    publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  fs.writeFileSync(policyFile, JSON.stringify({ schema: 'mongbas-c2sp-witness-policy/v1', quorum: 1,
    witnesses: [{ id: 'one', name: 'witness.example/one',
      publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] }));
  const cli = path.join(__dirname, '../bin/mongbas-c2sp.js');
  const result = spawnSync(process.execPath, [cli, 'submit', requestFile, noteFile,
    'http://witness.example/add-checkpoint', logTrustFile, policyFile, outputFile], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exact HTTPS/);
  assert.equal(fs.existsSync(outputFile), false);
});

function spawnCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('C2SP submit CLI completes a real local TLS round trip and fsyncs a verified non-overwriting output', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-c2sp-submit-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tlsKey = path.join(directory, 'tls-key.pem');
  const tlsCertificate = path.join(directory, 'tls-cert.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', tlsKey, '-out', tlsCertificate], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);

  const operator = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const origin = 'mongbas.example/cast-history/election-a';
  const note = createSignedCheckpoint({ origin, treeSize: 0,
    rootHash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'), privateKeyPem: pem(operator) });
  const requestText = createWitnessRequest({ oldSize: 0, consistencyPath: [], signedCheckpoint: note });
  const responseLine = cosignatureLine(note, 'witness.example/one', witness, Math.floor(Date.now() / 1000));
  let received = null;
  const server = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCertificate) }, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received = { method: request.method, url: request.url, contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8') };
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(responseLine) });
      response.end(responseLine);
    });
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const requestFile = path.join(directory, 'request.txt');
  const noteFile = path.join(directory, 'checkpoint.note');
  const trustFile = path.join(directory, 'log-trust.json');
  const policyFile = path.join(directory, 'witness-policy.json');
  const outputFile = path.join(directory, 'cosigned.note');
  fs.writeFileSync(requestFile, requestText);
  fs.writeFileSync(noteFile, note);
  fs.writeFileSync(trustFile, JSON.stringify({ origin,
    publicKeyDer: operator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  const policy = { schema: 'mongbas-c2sp-witness-policy/v1', quorum: 1,
    witnesses: [{ id: 'one', name: 'witness.example/one',
      publicKeyDer: witness.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] };
  fs.writeFileSync(policyFile, JSON.stringify(policy));

  const cli = path.join(__dirname, '../bin/mongbas-c2sp.js');
  const result = await spawnCapture(process.execPath, [cli, 'submit', requestFile, noteFile,
    `https://127.0.0.1:${port}/add-checkpoint`, trustFile, policyFile, outputFile], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: tlsCertificate },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /quorum=1\/1 ids=one/);
  assert.deepEqual(received, { method: 'POST', url: '/add-checkpoint', contentType: 'application/octet-stream', body: requestText });
  assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
  const output = fs.readFileSync(outputFile, 'utf8');
  parseAndVerifySignedCheckpoint(output, JSON.parse(fs.readFileSync(trustFile, 'utf8')));
  assert.equal(verifyWitnessCosignatures(output, { witnesses: policy.witnesses, quorum: 1 }).valid, true);
  const overwrite = await spawnCapture(process.execPath, [cli, 'submit', requestFile, noteFile,
    `https://127.0.0.1:${port}/add-checkpoint`, trustFile, policyFile, outputFile], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: tlsCertificate },
  });
  assert.equal(overwrite.code, 1);
  assert.match(overwrite.stderr, /already exists/);
});
