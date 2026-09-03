'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  G, HOMOMORPHIC_BASE, P, P_HEX, Q,
  canonicalize, merkleRoot, modInverse, modPow, sha256Hex, unsignedBundle, verifyBundle, verifyBundleBytes,
} = require('../src/verify');
const { buildUnsignedBundle, signBundle } = require('../src/bundle');
const { CHECKPOINT_SCHEMA, CHECKPOINT_V2_SCHEMA, TRUST_SCHEMA, checkpointHash, compareCheckpointLogs,
  compareIndependentWitnessLogs, createCheckpoint,
  createHistoryCheckpoint, parseCanonicalLog, publicKeyDer, verifyCheckpointLog } = require('../src/witness');
const { generateVectorBallot } = require('../../application/src/lib/vectorElgamal');

function scalar(label) {
  const value = BigInt(`0x${sha256Hex(label)}`) % Q;
  return value === 0n ? 1n : value;
}

function vectorArtifactHash(electionID, candidates, vector, proof) {
  return sha256Hex(canonicalize({ schema: 'mongbas-vector-audit-artifact/v1', electionID, candidates,
    encryptedCandidateVector: vector, vectorBallotValidityProof: proof }));
}

function lengthPrefixedHash(fields) {
  const hash = crypto.createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field);
    hash.update(bytes.length.toString(16).padStart(8, '0'));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function encryptAndProve(publicKeyY, candidateIndex, candidateCount, label) {
  const randomness = scalar(`${label}:r`);
  const message = modPow(G, HOMOMORPHIC_BASE ** BigInt(candidateIndex), P);
  const c1 = modPow(G, randomness, P);
  const c2 = (message * modPow(publicKeyY, randomness, P)) % P;
  const a1s = new Array(candidateCount);
  const a2s = new Array(candidateCount);
  const es = new Array(candidateCount);
  const zs = new Array(candidateCount);
  const witnessNonce = scalar(`${label}:witness`);
  let simulatedChallengeSum = 0n;
  for (let index = 0; index < candidateCount; index += 1) {
    if (index === candidateIndex) continue;
    const e = scalar(`${label}:e:${index}`);
    const z = scalar(`${label}:z:${index}`);
    const candidateMessage = modPow(G, HOMOMORPHIC_BASE ** BigInt(index), P);
    const divided = (c2 * modInverse(candidateMessage, P)) % P;
    a1s[index] = ((modPow(G, z, P) * modPow(modInverse(c1, P), e, P)) % P).toString(16);
    a2s[index] = ((modPow(publicKeyY, z, P) * modPow(modInverse(divided, P), e, P)) % P).toString(16);
    es[index] = e.toString(16);
    zs[index] = z.toString(16);
    simulatedChallengeSum = (simulatedChallengeSum + e) % Q;
  }
  a1s[candidateIndex] = modPow(G, witnessNonce, P).toString(16);
  a2s[candidateIndex] = modPow(publicKeyY, witnessNonce, P).toString(16);
  const challengeText = [c1.toString(16), c2.toString(16), ...a1s.flatMap((a1, index) => [a1, a2s[index]])].join('|');
  const totalChallenge = BigInt(`0x${sha256Hex(challengeText)}`) % Q;
  const realChallenge = (totalChallenge - simulatedChallengeSum + Q) % Q;
  es[candidateIndex] = realChallenge.toString(16);
  zs[candidateIndex] = ((witnessNonce + realChallenge * randomness) % Q).toString(16);
  return {
    ciphertext: { c1: c1.toString(16), c2: c2.toString(16) },
    validityProof: { a1s, a2s, es, zs },
  };
}

function decryptionProof(privateKey, publicKeyY, aggregate, sum) {
  const c1 = BigInt(`0x${aggregate.c1}`);
  const c2 = BigInt(`0x${aggregate.c2}`);
  const message = modPow(G, sum, P);
  const sharedSecret = (c2 * modInverse(message, P)) % P;
  const nonce = scalar('tally-proof-nonce');
  const a1 = modPow(G, nonce, P);
  const a2 = modPow(c1, nonce, P);
  const challengeText = [G, publicKeyY, c1, sharedSecret, a1, a2].map((value) => value.toString(16)).join('|');
  const challenge = BigInt(`0x${sha256Hex(challengeText)}`) % Q;
  const response = (nonce + challenge * privateKey) % Q;
  return {
    nullifierHash: 'HOMOMORPHIC_TALLY',
    c1: aggregate.c1,
    c2: aggregate.c2,
    decryptedHash: sha256Hex(`homomorphic_sum:${sum}`),
    a1: a1.toString(16),
    a2: a2.toString(16),
    e: challenge.toString(16),
    z: response.toString(16),
  };
}

function thresholdPartial(index, share, aggregate, mspID) {
  const c1 = BigInt(`0x${aggregate.c1}`);
  const y = modPow(G, share, P);
  const value = modPow(c1, share, P);
  const nonce = scalar(`partial:${index}:nonce`);
  const a1 = modPow(G, nonce, P);
  const a2 = modPow(c1, nonce, P);
  const challengeText = [G, y, c1, value, a1, a2].map((item) => item.toString(16)).join('|');
  const e = BigInt(`0x${sha256Hex(challengeText)}`) % Q;
  return {
    index, mspID, publicKeyY: y.toString(16), value: value.toString(16),
    proof: { c1: aggregate.c1, c2: value.toString(16), a1: a1.toString(16), a2: a2.toString(16), e: e.toString(16), z: ((nonce + e * share) % Q).toString(16) },
  };
}

function buildBundle(selections = [0, 1], signingKeys = null) {
  const electionID = 'verifier-known-answer-1';
  const candidates = ['ALICE', 'BOB'];
  const privateKey = scalar('election-private-key');
  const publicKeyY = modPow(G, privateKey, P);
  const ballots = selections.map((selection, index) => {
    const encrypted = encryptAndProve(publicKeyY, selection, candidates.length, `ballot:${index}`);
    const nullifierHash = sha256Hex(`nullifier:${index}`);
    const encryptedText = `${encrypted.ciphertext.c1}:${encrypted.ciphertext.c2}`;
    return {
      nullifierHash,
      candidateCommitment: sha256Hex(`${electionID}|${nullifierHash}|${encryptedText}`),
      ...encrypted,
    };
  });
  const aggregate = ballots.reduce((result, ballot) => ({
    c1: ((BigInt(`0x${result.c1}`) * BigInt(`0x${ballot.ciphertext.c1}`)) % P).toString(16),
    c2: ((BigInt(`0x${result.c2}`) * BigInt(`0x${ballot.ciphertext.c2}`)) % P).toString(16),
  }), { c1: '1', c2: '1' });
  const signer1 = signingKeys?.[0] ?? crypto.generateKeyPairSync('ed25519');
  const signer2 = signingKeys?.[1] ?? crypto.generateKeyPairSync('ed25519');
  const { publicKey: publicKey1, privateKey: privateKey1 } = signer1;
  const { publicKey: publicKey2, privateKey: privateKey2 } = signer2;
  const results = Object.fromEntries(candidates.map((candidate, index) =>
    [candidate, selections.filter(selection => selection === index).length]));
  const decryptedExponent = selections.reduce((sum, selection) => sum + HOMOMORPHIC_BASE ** BigInt(selection), 0n);
  const bundle = {
    schema: 'mongbas-election-bundle/v1',
    algorithms: {
      canonicalization: 'mongbas-canonical-json-v1',
      hash: 'sha-256',
      signature: 'ed25519',
      tally: 'mongbas-exp-elgamal-scalar-v1',
    },
    configuration: {
      electionID,
      candidates,
      signatureThreshold: 2,
      organizations: [
        { id: 'ec', ed25519PublicKeyDer: publicKey1.export({ format: 'der', type: 'spki' }).toString('base64') },
        { id: 'civil', ed25519PublicKeyDer: publicKey2.export({ format: 'der', type: 'spki' }).toString('base64') },
      ],
    },
    provenance: { gitCommit: '0123456789abcdef0123456789abcdef01234567', imageDigest: 'sha256:' + 'ab'.repeat(32), softwareVersion: 'test' },
    publicKey: { p: P_HEX, g: '2', y: publicKeyY.toString(16) },
    ballots,
    bulletinBoard: { root: merkleRoot(ballots), publishedAt: 1 },
    aggregateCiphertext: aggregate,
    tally: { results, totalVotes: selections.length },
    decryptionProof: decryptionProof(privateKey, publicKeyY, aggregate, decryptedExponent),
  };
  const payload = Buffer.from(canonicalize(unsignedBundle(bundle)));
  bundle.signatures = [
    { organizationID: 'ec', signature: crypto.sign(null, payload, privateKey1).toString('base64') },
    { organizationID: 'civil', signature: crypto.sign(null, payload, privateKey2).toString('base64') },
  ];
  return bundle;
}

test('accepts a complete independently verifiable 1:1 bundle', () => {
  const bundle = buildBundle();
  const result = verifyBundle(bundle);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.ballots, 2);
  assert.equal(result.validSignatures, 2);
  const canonicalResult = verifyBundleBytes(Buffer.from(canonicalize(bundle)));
  assert.equal(canonicalResult.valid, true, canonicalResult.errors?.join('\n'));
});

test('independent Python/OpenSSL verifier accepts v1 and rejects layered mutations', () => {
  const referencePath = path.join(__dirname, '../reference/python_bundle_v1_verify.py');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-python-bundle-v1-'));
  const run = (bundle, canonical = true) => {
    const bundlePath = path.join(directory, `bundle-${crypto.randomUUID()}.json`);
    fs.writeFileSync(bundlePath, canonical ? canonicalize(bundle) : JSON.stringify(bundle, null, 2));
    return spawnSync('python3', [referencePath, bundlePath], { encoding: 'utf8', timeout: 60_000 });
  };
  try {
    const valid = buildBundle();
    const accepted = run(valid);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), {
      ballots: 2, schema: 'mongbas-election-bundle/v1', valid: true, validSignatures: 2,
    });
    const mutations = [
      [/ballot proof equation/, value => { value.ballots[0].validityProof.zs[0] = '0'; }],
      [/aggregate mismatch/, value => { value.aggregateCiphertext.c1 = value.ballots[0].ciphertext.c1; }],
      [/decrypted hash/, value => { value.tally.results.ALICE = 0; value.tally.results.BOB = 2; }],
      [/bulletin board/, value => { value.bulletinBoard.root = '00'.repeat(32); }],
      [/signature verification/, value => { value.signatures[0].signature = Buffer.alloc(64).toString('base64'); }],
    ];
    for (const [expectedError, mutate] of mutations) {
      const changed = structuredClone(valid);
      mutate(changed);
      const rejected = run(changed);
      assert.equal(rejected.status, 1, `mutation unexpectedly accepted: ${rejected.stdout}`);
      assert.match(rejected.stderr, expectedError);
    }
    assert.equal(run(valid, false).status, 1, 'non-canonical bundle unexpectedly accepted');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const mutations = {
  'deleted ballot': (bundle) => { bundle.ballots.pop(); },
  'reordered ballots': (bundle) => { bundle.ballots.reverse(); },
  'changed ciphertext': (bundle) => { bundle.ballots[0].ciphertext.c2 = bundle.ballots[1].ciphertext.c2; },
  'deleted proof': (bundle) => { delete bundle.ballots[0].validityProof; },
  'changed bulletin root': (bundle) => { bundle.bulletinBoard.root = '00'.repeat(32); },
  'changed aggregate': (bundle) => { bundle.aggregateCiphertext.c1 = '2'; },
  'changed tally': (bundle) => { bundle.tally.results.ALICE = 2; },
  'changed decryption proof': (bundle) => { bundle.decryptionProof.z = '0'; },
  'deleted signature': (bundle) => { bundle.signatures.pop(); },
  'changed signature': (bundle) => { bundle.signatures[0].signature = Buffer.alloc(64).toString('base64'); },
  'algorithm downgrade': (bundle) => { bundle.algorithms.tally = 'none'; },
  'duplicate ballot': (bundle) => { bundle.ballots.push(structuredClone(bundle.ballots[0])); },
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects tamper corpus: ${name}`, () => {
    const bundle = buildBundle();
    mutate(bundle);
    const result = verifyBundle(bundle);
    assert.equal(result.valid, false, `${name} unexpectedly verified`);
    assert.ok(result.errors.length > 0);
  });
}

test('rejects a trivial zero-challenge decryption-proof forgery', () => {
  const bundle = buildBundle();
  bundle.decryptionProof.e = '0';
  bundle.decryptionProof.z = '1';
  bundle.decryptionProof.a1 = '2';
  bundle.decryptionProof.a2 = bundle.aggregateCiphertext.c1;
  const result = verifyBundle(bundle);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Fiat-Shamir challenge mismatch/);
});

test('rejects non-canonical JSON bytes', () => {
  const result = verifyBundleBytes(Buffer.from(JSON.stringify(buildBundle(), null, 2)));
  assert.equal(result.valid, false);
  assert.match(result.summary, /not canonical/);
});

const envelopeMutations = {
  'canonicalization downgrade': (bundle) => { bundle.algorithms.canonicalization = 'json'; },
  'hash downgrade': (bundle) => { bundle.algorithms.hash = 'sha-1'; },
  'signature downgrade': (bundle) => { bundle.algorithms.signature = 'none'; },
  'unexpected top-level field': (bundle) => { bundle.serverVerified = true; },
  'invalid provenance': (bundle) => { bundle.provenance.gitCommit = 'unknown'; },
  'duplicate organization id': (bundle) => { bundle.configuration.organizations[1].id = bundle.configuration.organizations[0].id; },
  'unexpected tally result': (bundle) => { bundle.tally.results.EXTRA = 0; },
};

for (const [name, mutate] of Object.entries(envelopeMutations)) {
  test(`rejects signed-envelope inconsistency: ${name}`, () => {
    const bundle = buildBundle();
    mutate(bundle);
    const result = verifyBundle(bundle);
    assert.equal(result.valid, false, `${name} unexpectedly verified`);
    assert.match(result.errors.join('\n'), /bundle envelope/);
  });
}

test('malformed bundle objects return an invalid result instead of throwing', () => {
  for (const value of [null, {}, { schema: 'mongbas-election-bundle/v4' }, { schema: 'unknown', configuration: null }]) {
    assert.doesNotThrow(() => verifyBundle(value));
    assert.equal(verifyBundle(value).valid, false);
  }
});

test('builds and independently signs an exported live-source shape', () => {
  const fixture = buildBundle();
  const signer1 = crypto.generateKeyPairSync('ed25519');
  const signer2 = crypto.generateKeyPairSync('ed25519');
  const organizations = [signer1, signer2].map((signer, index) => ({
    id: index === 0 ? 'ec' : 'civil',
    ed25519PublicKeyDer: signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }));
  const source = {
    schema: 'mongbas-election-bundle-source/v1',
    encryptionMode: 'elgamal',
    configuration: { ...fixture.configuration, organizations },
    provenance: fixture.provenance,
    publicKey: fixture.publicKey,
    ballots: fixture.ballots.map((ballot) => ({
      nullifierHash: ballot.nullifierHash,
      candidateCommitment: ballot.candidateCommitment,
      encryptedCandidateID: `${ballot.ciphertext.c1}:${ballot.ciphertext.c2}`,
      ballotValidityProof: ballot.validityProof,
    })),
    tallyResults: fixture.tally.results,
    totalVotes: fixture.tally.totalVotes,
    decryptionProofs: [{
      nullifierHash: 'HOMOMORPHIC_TALLY',
      encryptedCandidateID: `${fixture.aggregateCiphertext.c1}:${fixture.aggregateCiphertext.c2}`,
      decryptedHash: fixture.decryptionProof.decryptedHash,
      zkProof: fixture.decryptionProof,
    }],
    publishedAt: fixture.bulletinBoard.publishedAt,
  };
  let bundle = buildUnsignedBundle(source);
  assert.equal(verifyBundle(bundle).valid, false, 'unsigned bundle must not verify');
  bundle = signBundle(bundle, 'ec', signer1.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  assert.equal(verifyBundle(bundle).valid, false, 'below-threshold bundle must not verify');
  bundle = signBundle(bundle, 'civil', signer2.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const result = verifyBundle(bundle);
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.validSignatures, 2);
});

test('offline signer rejects a key that does not match the configured organization', () => {
  const bundle = buildBundle();
  bundle.signatures = [];
  const wrongKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => signBundle(bundle, 'ec', wrongKey), /does not match/);
});

test('builds and verifies a 2-of-3 threshold bundle without a private-key reconstruction proof', () => {
  const legacy = buildBundle();
  const secret = scalar('threshold-election-secret');
  const coefficient = scalar('threshold-coefficient');
  const shares = [1, 2, 3].map((index) => (secret + coefficient * BigInt(index)) % Q);
  const publicKeyY = modPow(G, secret, P);
  const ballots = [0, 1].map((selection, index) => {
    const encrypted = encryptAndProve(publicKeyY, selection, 2, `threshold-ballot:${index}`);
    const nullifierHash = sha256Hex(`threshold-nullifier:${index}`);
    const encryptedCandidateID = `${encrypted.ciphertext.c1}:${encrypted.ciphertext.c2}`;
    return { nullifierHash, candidateCommitment: sha256Hex(`threshold-test|${nullifierHash}|${encryptedCandidateID}`), encryptedCandidateID, ballotValidityProof: encrypted.validityProof };
  });
  const aggregate = ballots.reduce((result, ballot) => {
    const [c1, c2] = ballot.encryptedCandidateID.split(':').map((item) => BigInt(`0x${item}`));
    return { c1: ((BigInt(`0x${result.c1}`) * c1) % P).toString(16), c2: ((BigInt(`0x${result.c2}`) * c2) % P).toString(16) };
  }, { c1: '1', c2: '1' });
  const mspIDs = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
  const source = {
    schema: 'mongbas-election-bundle-source/v1', encryptionMode: 'elgamal',
    configuration: { ...legacy.configuration, electionID: 'threshold-test' }, provenance: legacy.provenance,
    publicKey: { p: P_HEX, g: '2', y: publicKeyY.toString(16) }, ballots,
    tallyResults: { ALICE: 1, BOB: 1 }, totalVotes: 2, aggregateCiphertext: aggregate,
    thresholdPublicShares: shares.map((share, offset) => ({ index: offset + 1, mspID: mspIDs[offset], publicKeyY: modPow(G, share, P).toString(16) })),
    partialDecryptions: [thresholdPartial(1, shares[0], aggregate, mspIDs[0]), thresholdPartial(2, shares[1], aggregate, mspIDs[1])],
    publishedAt: 1,
  };
  let bundle = buildUnsignedBundle(source);
  assert.equal(bundle.schema, 'mongbas-election-bundle/v2');
  const keys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  bundle.configuration.organizations = keys.map((key, index) => ({ id: index ? 'civil' : 'ec', ed25519PublicKeyDer: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  bundle = signBundle(bundle, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  bundle = signBundle(bundle, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  assert.equal(verifyBundle(bundle).valid, true, verifyBundle(bundle).errors.join('\n'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-python-bundle-v2-'));
  const referencePath = path.join(__dirname, '../reference/python_bundle_v2_verify.py');
  const runReference = value => {
    const bundlePath = path.join(directory, `bundle-${crypto.randomUUID()}.json`);
    fs.writeFileSync(bundlePath, canonicalize(value));
    return spawnSync('python3', [referencePath, bundlePath], { encoding: 'utf8', timeout: 60_000 });
  };
  try {
    const accepted = runReference(bundle);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), { ballots: 2, schema: 'mongbas-election-bundle/v2', valid: true, validPartials: 2, validSignatures: 2 });
    const mutations = [
      [/partial proof equation/, value => { value.partialDecryptions[0].proof.z = '0'; }],
      [/trustee binding/, value => { value.partialDecryptions[0].mspID = 'other'; }],
      [/threshold tally/, value => { value.tally.results.ALICE = 0; value.tally.results.BOB = 2; }],
    ];
    for (const [expectedError, mutate] of mutations) {
      const changed = structuredClone(bundle);
      mutate(changed);
      const rejected = runReference(changed);
      assert.equal(rejected.status, 1, `v2 mutation unexpectedly accepted: ${rejected.stdout}`);
      assert.match(rejected.stderr, expectedError);
    }
    let invalidUnusedShare = structuredClone(bundle);
    invalidUnusedShare.trusteePublicShares[2].publicKeyY = '0';
    invalidUnusedShare.signatures = [];
    invalidUnusedShare = signBundle(invalidUnusedShare, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
    invalidUnusedShare = signBundle(invalidUnusedShare, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
    assert.equal(verifyBundle(invalidUnusedShare).valid, false, 'invalid unused public share unexpectedly accepted');
    const independentlyRejected = runReference(invalidUnusedShare);
    assert.equal(independentlyRejected.status, 1, 'Python accepted invalid unused public share');
    assert.match(independentlyRejected.stderr, /public share group element/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  bundle.partialDecryptions[0].proof.z = '0';
  assert.equal(verifyBundle(bundle).valid, false, 'tampered threshold proof must fail');
});

function buildVectorBundle({ dkg = false } = {}) {
  const legacy = buildBundle(), electionID = 'vector-v3-test', candidates = ['A', 'B', 'C'];
  const secret = scalar('vector-secret'), coefficient = scalar('vector-coefficient');
  const shares = [1, 2, 3].map((index) => (secret + coefficient * BigInt(index)) % Q);
  const publicKeyY = modPow(G, secret, P), publicKey = { p: P_HEX, g: '2', y: publicKeyY.toString(16) };
  const ballots = [0, 1, 2, 0].map((selection, index) => {
    const generated = generateVectorBallot(publicKey, selection, candidates.length);
    const nullifierHash = sha256Hex(`vector-nullifier:${index}`);
    return { nullifierHash, preparedBallotID: sha256Hex(`prepared:${index}`), candidateCommitment: sha256Hex(`${electionID}|${nullifierHash}|${JSON.stringify(generated.encryptedCandidateVector)}`),
      encryptedCandidateVector: generated.encryptedCandidateVector, vectorBallotValidityProof: generated.vectorBallotValidityProof };
  });
	const vectorBallotReceipts = ballots.map((ballot, index) => ({ schema: 'mongbas-vector-ballot-receipt/v1',
	  ballotID: ballot.preparedBallotID, electionID,
	  artifactHash: vectorArtifactHash(electionID, candidates, ballot.encryptedCandidateVector, ballot.vectorBallotValidityProof),
	  status: 'cast', createdAt: 1, createdTxID: `prepare-tx-${index}`, terminalAt: 2, terminalTxID: `cast-tx-${index}` }));
	const audited = generateVectorBallot(publicKey, 2, candidates.length);
	const auditedArtifactHash = vectorArtifactHash(electionID, candidates, audited.encryptedCandidateVector, audited.vectorBallotValidityProof);
	const clientNonce = 'ab'.repeat(32);
	const auditedBallotID = lengthPrefixedHash(['mongbas/vector-aoc/v1', electionID, sha256Hex(clientNonce), auditedArtifactHash]);
	vectorBallotReceipts.push({ schema: 'mongbas-vector-ballot-receipt/v1', ballotID: auditedBallotID, electionID,
	  artifactHash: auditedArtifactHash, status: 'audited', createdAt: 1, createdTxID: 'prepare-audit-tx', terminalAt: 2, terminalTxID: 'audit-tx' });
	const vectorAuditDisclosures = [{ schema: 'mongbas-vector-audit-disclosure/v1', ballotID: auditedBallotID, electionID,
	  artifactHash: auditedArtifactHash, selectedIndex: 2, clientNonce, randomness: [...audited._auditWitness.randomness],
	  encryptedCandidateVector: audited.encryptedCandidateVector, vectorBallotValidityProof: audited.vectorBallotValidityProof,
	  status: 'audited', auditedAt: 2, auditedTxID: 'audit-tx' }];
  const aggregates = candidates.map((_, candidateIndex) => ballots.reduce((aggregate, ballot) => ({
    c1: ((BigInt(`0x${aggregate.c1}`) * BigInt(`0x${ballot.encryptedCandidateVector[candidateIndex].c1}`)) % P).toString(16),
    c2: ((BigInt(`0x${aggregate.c2}`) * BigInt(`0x${ballot.encryptedCandidateVector[candidateIndex].c2}`)) % P).toString(16),
  }), { c1: '1', c2: '1' }));
  const mspIDs = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
  const vectorPartials = [0, 1].map((offset) => ({ index: offset + 1, mspID: mspIDs[offset], publicKeyY: modPow(G, shares[offset], P).toString(16),
    values: aggregates.map((aggregate) => thresholdPartial(offset + 1, shares[offset], aggregate, mspIDs[offset]).value),
    proofs: aggregates.map((aggregate) => thresholdPartial(offset + 1, shares[offset], aggregate, mspIDs[offset]).proof) }));
  let keyCeremony;
  if (dkg) {
	const constantScalars = [scalar('dkg-constant-1'), scalar('dkg-constant-2')];
	constantScalars.push((secret - constantScalars[0] - constantScalars[1] + 2n * Q) % Q);
	const linearScalars = [scalar('dkg-linear-1'), scalar('dkg-linear-2')];
	linearScalars.push((coefficient - linearScalars[0] - linearScalars[1] + 2n * Q) % Q);
	const participants = mspIDs.map((id, offset) => {
	  const transport = crypto.generateKeyPairSync('x25519');
	  const signing = crypto.generateKeyPairSync('ed25519');
	  return { id, index: offset + 1,
		transportPublicKeyDer: transport.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
		signingPublicKeyDer: signing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
	});
	const transcript = { schema: 'mongbas-feldman-dkg-transcript/v1', ceremonyID: 'verifier-dkg-test', threshold: 2, totalTrustees: 3,
	  group: { p: P_HEX, g: '2', q: Q.toString(16) }, participants,
	  contributions: mspIDs.map((dealerID, offset) => ({ dealerID, commitments: {
		constant: modPow(G, constantScalars[offset], P).toString(16), linear: modPow(G, linearScalars[offset], P).toString(16),
	  }, contributionHash: sha256Hex(`contribution:${offset}`) })),
	  publicShares: shares.map((share, offset) => ({ schema: 'mongbas-dkg-public-share/v1', ceremonyID: 'verifier-dkg-test', trusteeID: mspIDs[offset], trusteeIndex: offset + 1, publicKeyY: modPow(G, share, P).toString(16) })),
	  electionPublicKeyY: publicKey.y };
	transcript.transcriptHash = sha256Hex(canonicalize(transcript));
	keyCeremony = { mode: 'dkg-v1', transcript, transcriptHash: transcript.transcriptHash, approvals: [...mspIDs].sort() };
  }
  const source = { schema: 'mongbas-election-bundle-source/v1', encryptionMode: 'elgamal-vector-v3',
    configuration: { ...legacy.configuration, electionID, candidates }, provenance: legacy.provenance, publicKey, ballots,
    tallyResults: { A: 2, B: 1, C: 1 }, totalVotes: 4, aggregateCiphertextVector: aggregates,
    thresholdPublicShares: shares.map((share, offset) => ({ index: offset + 1, mspID: mspIDs[offset], publicKeyY: modPow(G, share, P).toString(16) })),
    vectorPartialDecryptions: vectorPartials, vectorBallotReceipts, vectorAuditDisclosures, publishedAt: 1,
	...(keyCeremony ? { keyCeremony } : {}) };
  let bundle = buildUnsignedBundle(source);
  assert.equal(bundle.schema, dkg ? 'mongbas-election-bundle/v5' : 'mongbas-election-bundle/v4');
  const keys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  bundle.configuration.organizations = keys.map((key, index) => ({ id: index ? 'civil' : 'ec', ed25519PublicKeyDer: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  bundle = signBundle(bundle, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  bundle = signBundle(bundle, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return bundle;
}

test('verifies a DKG v5 bundle and recomputes every public commitment equation', () => {
  const bundle = buildVectorBundle({ dkg: true });
  assert.equal(verifyBundle(bundle).valid, true, verifyBundle(bundle).errors.join('\n'));
  const mutations = [
	(value) => { value.keyCeremony.approvals.pop(); },
	(value) => { value.keyCeremony.transcriptHash = '00'.repeat(32); },
	(value) => { value.keyCeremony.transcript.contributions[0].commitments.linear = '2'; },
	(value) => { value.keyCeremony.transcript.publicShares[0].publicKeyY = value.keyCeremony.transcript.publicShares[1].publicKeyY; },
	(value) => { value.keyCeremony.transcript.electionPublicKeyY = value.keyCeremony.transcript.publicShares[0].publicKeyY; },
	(value) => { value.trusteePublicShares[0].publicKeyY = value.trusteePublicShares[1].publicKeyY; },
  ];
  for (const mutate of mutations) {
	const changed = structuredClone(bundle);
	mutate(changed);
	assert.equal(verifyBundle(changed).valid, false, 'tampered DKG evidence unexpectedly verified');
  }
});

test('builds and verifies vector-v3 one-hot ballots and per-candidate threshold decryptions', () => {
  const bundle = buildVectorBundle();
  const result = verifyBundle(bundle);
  assert.equal(result.valid, true, result.errors.join('\n'));
  bundle.ballots[0].validityProof.sumProof.z = '0';
  assert.equal(verifyBundle(bundle).valid, false, 'tampered vector sum proof must fail');
});

test('independent Python/OpenSSL verifier checks the complete vector-v4 bundle', () => {
  const bundle = buildVectorBundle();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-python-bundle-v4-'));
  const referencePath = path.join(__dirname, '../reference/python_bundle_v4_verify.py');
  const run = value => {
    const bundlePath = path.join(directory, `bundle-${crypto.randomUUID()}.json`);
    fs.writeFileSync(bundlePath, canonicalize(value));
    return spawnSync('python3', [referencePath, bundlePath], { encoding: 'utf8', timeout: 120_000 });
  };
  try {
    const accepted = run(bundle);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout), {
      auditDisclosures: 1, ballots: 4, schema: 'mongbas-election-bundle/v4', valid: true, validPartials: 2, validSignatures: 2,
    });
    const mutations = [
      [/bit proof equation/, value => { value.ballots[0].validityProof.bitProofs[0].zs[0] = '0'; }],
      [/vector aggregate/, value => { value.aggregateCiphertextVector[0].c1 = '2'; }],
      [/vector partial proof/, value => { value.vectorPartialDecryptions[0].proofs[0].z = '0'; }],
      [/audit re-encryption/, value => { value.vectorAuditDisclosures[0].randomness[0] = '1'; }],
      [/signature verification/, value => { value.signatures[0].signature = Buffer.alloc(64).toString('base64'); }],
    ];
    for (const [expectedError, mutate] of mutations) {
      const changed = structuredClone(bundle);
      mutate(changed);
      const rejected = run(changed);
      assert.equal(rejected.status, 1, `v4 mutation unexpectedly accepted: ${rejected.stdout}`);
      assert.match(rejected.stderr, expectedError);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a signed vector-v4 bundle with an invalid unused trustee public share', () => {
  let bundle = buildVectorBundle();
  bundle.trusteePublicShares[2].publicKeyY = '0';
  const keys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  bundle.configuration.organizations = keys.map((key, index) => ({
    id: index ? 'civil' : 'ec',
    ed25519PublicKeyDer: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }));
  bundle.signatures = [];
  bundle = signBundle(bundle, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  bundle = signBundle(bundle, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const result = verifyBundle(bundle);
  assert.equal(result.valid, false, 'invalid unused vector public share unexpectedly accepted');
  assert.match(result.errors.join('\n'), /publicShare\[2\]\.publicKeyY/);
});

test('rejects re-signed vector-v4 audit evidence outside schema timestamp and transaction bounds', () => {
  const original = buildVectorBundle();
  const cases = [
    value => { value.vectorBallotReceipts[0].createdAt = -1; },
    value => { value.vectorBallotReceipts[0].terminalAt = -1; },
    value => { value.vectorAuditDisclosures[0].auditedAt = -1; },
    value => { value.vectorAuditDisclosures[0].auditedTxID = ''; },
  ];
  for (const mutate of cases) {
    let bundle = structuredClone(original);
    mutate(bundle);
    const keys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
    bundle.configuration.organizations = keys.map((key, index) => ({
      id: index ? 'civil' : 'ec', ed25519PublicKeyDer: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }));
    bundle.signatures = [];
    bundle = signBundle(bundle, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
    bundle = signBundle(bundle, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
    assert.equal(verifyBundle(bundle).valid, false, 'out-of-schema audit metadata unexpectedly accepted');
  }
});

test('runtime rejects re-signed nested fields forbidden by the published schemas', () => {
  const cases = [
    [buildBundle(), value => { value.ballots[0].unexpected = true; }],
    [buildBundle(), value => { value.ballots[0].ciphertext.unexpected = true; }],
    [buildBundle(), value => { value.aggregateCiphertext.unexpected = true; }],
    [buildBundle(), value => { value.decryptionProof.unexpected = true; }],
    [buildVectorBundle(), value => { value.ballots[0].validityProof.unexpected = true; }],
    [buildVectorBundle(), value => { value.aggregateCiphertextVector[0].unexpected = true; }],
    [buildVectorBundle(), value => { value.vectorPartialDecryptions[0].unexpected = true; }],
  ];
  for (const [original, mutate] of cases) {
    let bundle = structuredClone(original);
    mutate(bundle);
    const keys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
    bundle.configuration.organizations = keys.map((key, index) => ({
      id: index ? 'civil' : 'ec', ed25519PublicKeyDer: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }));
    bundle.signatures = [];
    bundle = signBundle(bundle, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
    bundle = signBundle(bundle, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
    assert.equal(verifyBundle(bundle).valid, false, 'schema-forbidden nested field unexpectedly accepted');
  }
});

const vectorMutations = {
  'deleted ballot': (bundle) => { bundle.ballots.pop(); },
  'replaced ballot': (bundle) => { bundle.ballots[0] = structuredClone(bundle.ballots[1]); },
  'reordered ballots': (bundle) => { bundle.ballots.reverse(); },
  'changed ciphertext': (bundle) => { bundle.ballots[0].ciphertextVector[0].c2 = bundle.ballots[1].ciphertextVector[0].c2; },
  'deleted validity proof': (bundle) => { delete bundle.ballots[0].validityProof; },
  'changed bulletin root': (bundle) => { bundle.bulletinBoard.root = '00'.repeat(32); },
  'changed aggregate vector': (bundle) => { bundle.aggregateCiphertextVector[0].c1 = '2'; },
  'changed partial value': (bundle) => { bundle.vectorPartialDecryptions[0].values[0] = '2'; },
  'changed partial proof': (bundle) => { bundle.vectorPartialDecryptions[0].proofs[0].z = '0'; },
  'changed tally': (bundle) => { bundle.tally.results.A += 1; },
  'deleted signature': (bundle) => { bundle.signatures.pop(); },
  'changed signature': (bundle) => { bundle.signatures[0].signature = Buffer.alloc(64).toString('base64'); },
  'algorithm downgrade': (bundle) => { bundle.algorithms.signature = 'none'; },
  'schema downgrade to v3': (bundle) => { bundle.schema = 'mongbas-election-bundle/v3'; },
  'duplicate ballot': (bundle) => { bundle.ballots.push(structuredClone(bundle.ballots[0])); },
  'deleted cast receipt': (bundle) => { bundle.vectorBallotReceipts = bundle.vectorBallotReceipts.filter(receipt => receipt.ballotID !== bundle.ballots[0].preparedBallotID); },
  'changed cast artifact hash': (bundle) => { bundle.vectorBallotReceipts.find(receipt => receipt.status === 'cast').artifactHash = '00'.repeat(32); },
  'duplicate vector receipt': (bundle) => { bundle.vectorBallotReceipts.push(structuredClone(bundle.vectorBallotReceipts[0])); },
  'deleted audit disclosure': (bundle) => { bundle.vectorAuditDisclosures = []; },
  'changed audit nonce': (bundle) => { bundle.vectorAuditDisclosures[0].clientNonce = 'cd'.repeat(32); },
  'changed audit randomness': (bundle) => { bundle.vectorAuditDisclosures[0].randomness[0] = '1'; },
  'changed audited ciphertext': (bundle) => { bundle.vectorAuditDisclosures[0].encryptedCandidateVector[0].c2 = '2'; },
};

for (const [name, mutate] of Object.entries(vectorMutations)) {
  test(`rejects vector-v3 tamper corpus: ${name}`, () => {
    const bundle = buildVectorBundle();
    mutate(bundle);
    const result = verifyBundle(bundle);
    assert.equal(result.valid, false, `${name} unexpectedly verified`);
    assert.ok(result.errors.length > 0);
  });
}

test('tamper-corpus CLI emits 22 independently rejected canonical bundles', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-tamper-'));
  try {
    const input = path.join(temporary, 'valid.json');
    const output = path.join(temporary, 'corpus');
    fs.writeFileSync(input, canonicalize(buildVectorBundle()));
    const generated = spawnSync(process.execPath, [path.join(__dirname, '../bin/mongbas-tamper-corpus.js'), input, output], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 22);
    for (const entry of manifest) {
      const result = verifyBundleBytes(fs.readFileSync(path.join(output, entry.filename)));
      assert.equal(result.valid, false, `${entry.name} unexpectedly verified`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('independent witness creates a signed append-only checkpoint chain', () => {
  const bundle = buildBundle();
  const verification = verifyBundle(bundle);
  const witness = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = witness.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'mac-observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  const first = createCheckpoint({ bundle, verification, witnessID: 'mac-observer', privateKeyPem, sequence: 1,
    observedAt: '2026-09-02T00:00:00.000Z' });
  const second = createCheckpoint({ bundle, verification, witnessID: 'mac-observer', privateKeyPem, sequence: 2,
    previousCheckpointHash: checkpointHash(first), observedAt: '2026-09-02T00:01:00.000Z' });
  const result = verifyCheckpointLog([first, second], trust);
  assert.equal(result.valid, true);
  assert.equal(result.checkpoints, 2);
  assert.equal(result.latestCheckpointHash, checkpointHash(second));
});

test('witness rejects checkpoint mutation, broken hash chain and untrusted key', () => {
  const bundle = buildBundle(), verification = verifyBundle(bundle);
  const signer = crypto.generateKeyPairSync('ed25519'), other = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = signer.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  const first = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 1 });
  const changed = structuredClone(first); changed.ballotCount += 1;
  assert.throws(() => verifyCheckpointLog([changed], trust), /invalid signature/);
  const wrongChain = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 2,
    previousCheckpointHash: '00'.repeat(32) });
  assert.throws(() => verifyCheckpointLog([first, wrongChain], trust), /hash chain/);
  const untrusted = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] };
  assert.throws(() => verifyCheckpointLog([first], untrusted), /untrusted witness key/);
});

test('witness construction rejects a valid verification result paired with another bundle', () => {
  const firstBundle = buildBundle(), secondBundle = buildBundle();
  const signer = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => createCheckpoint({
    bundle: firstBundle,
    verification: verifyBundle(secondBundle),
    witnessID: 'observer',
    privateKeyPem: signer.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    sequence: 1,
  }), /does not match/);
});

test('history checkpoint v2 proves ballot-prefix growth without changing bundle semantics', () => {
  const organizationKeys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  const firstBundle = buildBundle([0, 1], organizationKeys);
  const secondBundle = buildBundle([0, 1, 0], organizationKeys);
  const witness = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = witness.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  const first = createHistoryCheckpoint({ bundle: firstBundle, verification: verifyBundle(firstBundle), witnessID: 'observer',
    privateKeyPem, observedAt: '2026-09-03T00:00:00.000Z' });
  const second = createHistoryCheckpoint({ bundle: secondBundle, verification: verifyBundle(secondBundle), witnessID: 'observer',
    privateKeyPem, previousCheckpoint: first, observedAt: '2026-09-03T00:01:00.000Z' });

  assert.equal(first.schema, CHECKPOINT_V2_SCHEMA);
  assert.equal(first.history.previousTreeSize, 0);
  assert.equal(second.history.previousTreeSize, 2);
  assert.deepEqual(verifyCheckpointLog([first, second], trust), {
    valid: true,
    checkpoints: 2,
    latestCheckpointHash: checkpointHash(second),
    latest: second,
    historyVerifiedFromSequence: 1,
  });

  const replacedPrefix = buildBundle([1, 0, 0], organizationKeys);
  assert.throws(() => createHistoryCheckpoint({ bundle: replacedPrefix, verification: verifyBundle(replacedPrefix), witnessID: 'observer',
    privateKeyPem, previousCheckpoint: first }), /not an append-only extension/);

  const legacy = createCheckpoint({ bundle: firstBundle, verification: verifyBundle(firstBundle), witnessID: 'observer',
    privateKeyPem, sequence: 1, observedAt: '2026-09-02T00:00:00.000Z' });
  assert.throws(() => createHistoryCheckpoint({ bundle: secondBundle, verification: verifyBundle(secondBundle), witnessID: 'observer',
    privateKeyPem, previousCheckpoint: legacy, migrationFromV1: true, observedAt: '2026-09-03T00:00:00.000Z' }),
  /exact previously witnessed bundle snapshot/);
});

test('checkpoint log verifier rejects a signed v1 migration to a different snapshot', () => {
  const organizationKeys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  const legacyBundle = buildBundle([0, 1], organizationKeys);
  const substitutedBundle = buildBundle([1, 0], organizationKeys);
  const witness = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = witness.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  const legacy = createCheckpoint({ bundle: legacyBundle, verification: verifyBundle(legacyBundle), witnessID: 'observer',
    privateKeyPem, sequence: 1, observedAt: '2026-09-02T00:00:00.000Z' });

  // Model a malicious or alternate signer implementation that bypasses createHistoryCheckpoint's
  // exact-snapshot migration guard but still produces an otherwise authentic checkpoint.
  const substituted = createHistoryCheckpoint({ bundle: substitutedBundle, verification: verifyBundle(substitutedBundle),
    witnessID: 'observer', privateKeyPem, observedAt: '2026-09-03T00:00:00.000Z' });
  substituted.sequence = 2;
  substituted.previousCheckpointHash = checkpointHash(legacy);
  const unsignedSubstituted = structuredClone(substituted);
  delete unsignedSubstituted.signature;
  substituted.signature = crypto.sign(null, Buffer.from(canonicalize(unsignedSubstituted)), witness.privateKey).toString('base64');

  assert.throws(() => verifyCheckpointLog([legacy, substituted], trust),
    /v1 migration requires the exact previously witnessed bundle snapshot/);
});

test('history checkpoint v2 rejects downgrade and timestamp rollback while v1 remains valid', () => {
  const bundle = buildBundle(), verification = verifyBundle(bundle), witness = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = witness.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  const v1 = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 1 });
  assert.equal(v1.schema, CHECKPOINT_SCHEMA);
  assert.equal(verifyCheckpointLog([v1], trust).valid, true);

  const first = createHistoryCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem,
    observedAt: '2026-09-03T00:01:00.000Z' });
  assert.throws(() => createHistoryCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem,
    previousCheckpoint: first, observedAt: '2026-09-03T00:00:00.000Z' }), /timestamp rollback/);
  const rollback = createHistoryCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem,
    previousCheckpoint: first, observedAt: '2026-09-03T00:02:00.000Z' });
  rollback.observedAt = '2026-09-03T00:00:00.000Z';
  const unsignedRollback = structuredClone(rollback);
  delete unsignedRollback.signature;
  rollback.signature = crypto.sign(null, Buffer.from(canonicalize(unsignedRollback)), witness.privateKey).toString('base64');
  assert.throws(() => verifyCheckpointLog([first, rollback], trust), /timestamp rollback/);

  const downgrade = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 2,
    previousCheckpointHash: checkpointHash(first), observedAt: '2026-09-03T00:02:00.000Z' });
  assert.throws(() => verifyCheckpointLog([first, downgrade], trust), /downgrade/);
});

test('witness gossip accepts a consistent prefix and rejects two valid signed forks', () => {
  const bundle = buildBundle(), verification = verifyBundle(bundle), signer = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = signer.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: 'observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  const first = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 1,
    observedAt: '2026-09-02T00:00:00.000Z' });
  const second = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 2,
    previousCheckpointHash: checkpointHash(first), observedAt: '2026-09-02T00:01:00.000Z' });
  const fork = createCheckpoint({ bundle, verification, witnessID: 'observer', privateKeyPem, sequence: 2,
    previousCheckpointHash: checkpointHash(first), observedAt: '2026-09-02T00:02:00.000Z' });
  assert.equal(verifyCheckpointLog([first, fork], trust).valid, true);
  assert.deepEqual(compareCheckpointLogs([[first], [first, second]], trust), {
    valid: true, witnessID: 'observer', logs: 2, checkpoints: 2, latestCheckpointHash: checkpointHash(second),
  });
  assert.throws(() => compareCheckpointLogs([[first, second], [first, fork]], trust), /equivocation at sequence 2/);
});

test('independent witnesses agree on shared history snapshots and reject split views', () => {
  const organizationKeys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  const firstBundle = buildBundle([0, 1], organizationKeys);
  const secondBundle = buildBundle([0, 1, 0], organizationKeys);
  const forkBundle = buildBundle([1, 0], organizationKeys);
  const mac = crypto.generateKeyPairSync('ed25519');
  const linux = crypto.generateKeyPairSync('ed25519');
  const macPem = mac.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const linuxPem = linux.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const trust = { schema: TRUST_SCHEMA, witnesses: [
    { id: 'mac-observer', ed25519PublicKeyDer: publicKeyDer(macPem) },
    { id: 'linux-observer', ed25519PublicKeyDer: publicKeyDer(linuxPem) },
  ] };
  const macFirst = createHistoryCheckpoint({ bundle: firstBundle, verification: verifyBundle(firstBundle),
    witnessID: 'mac-observer', privateKeyPem: macPem, observedAt: '2026-09-03T00:00:00.000Z' });
  const macSecond = createHistoryCheckpoint({ bundle: secondBundle, verification: verifyBundle(secondBundle),
    witnessID: 'mac-observer', privateKeyPem: macPem, previousCheckpoint: macFirst,
    observedAt: '2026-09-03T00:01:00.000Z' });
  const linuxFirst = createHistoryCheckpoint({ bundle: firstBundle, verification: verifyBundle(firstBundle),
    witnessID: 'linux-observer', privateKeyPem: linuxPem, observedAt: '2026-09-03T00:00:30.000Z' });

  assert.deepEqual(compareIndependentWitnessLogs([[macFirst, macSecond], [linuxFirst]], trust), {
    valid: true, witnessIDs: ['linux-observer', 'mac-observer'], logs: 2,
    sharedSnapshots: 1, sharedTreeSizes: [2], largestTreeSize: 3,
  });

  const linuxFork = createHistoryCheckpoint({ bundle: forkBundle, verification: verifyBundle(forkBundle),
    witnessID: 'linux-observer', privateKeyPem: linuxPem, observedAt: '2026-09-03T00:00:30.000Z' });
  assert.throws(() => compareIndependentWitnessLogs([[macFirst], [linuxFork]], trust),
    /split view at history tree size 2/);
  const fourthBundle = buildBundle([0, 1, 0, 1], organizationKeys);
  const linuxFourth = createHistoryCheckpoint({ bundle: fourthBundle, verification: verifyBundle(fourthBundle),
    witnessID: 'linux-observer', privateKeyPem: linuxPem, observedAt: '2026-09-03T00:02:00.000Z' });
  assert.throws(() => compareIndependentWitnessLogs([[macFirst, macSecond], [linuxFourth]], trust),
    /no shared history snapshot/);
});

test('Python/OpenSSL independently verifies canonical checkpoint signed bytes and context binding', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-python-checkpoint-'));
  try {
    const source = buildBundle();
    const signer = crypto.generateKeyPairSync('ed25519');
    const privateKeyPem = signer.privateKey.export({ format: 'pem', type: 'pkcs8' });
    const checkpoint = createHistoryCheckpoint({ bundle: source, verification: verifyBundle(source),
      witnessID: 'python-cross-check', privateKeyPem, observedAt: '2026-09-03T00:00:00.000Z' });
    const checkpointPath = path.join(temporary, 'checkpoint.json');
    fs.writeFileSync(checkpointPath, canonicalize(checkpoint));
    const referencePath = path.join(__dirname, '../reference/python_checkpoint_verify.py');
    const args = [referencePath, checkpointPath, checkpoint.witnessPublicKeyDer,
      checkpoint.electionID, checkpoint.history.contextHash];
    const accepted = spawnSync('python3', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.match(accepted.stdout, /VALID independent checkpoint signature/);

    const wrongElection = spawnSync('python3', [...args.slice(0, 3), 'wrong-election', args[4]], { encoding: 'utf8' });
    assert.equal(wrongElection.status, 1);
    assert.match(wrongElection.stderr, /election mismatch/);
    const wrongContext = spawnSync('python3', [...args.slice(0, 4), '00'.repeat(32)], { encoding: 'utf8' });
    assert.equal(wrongContext.status, 1);
    assert.match(wrongContext.stderr, /context mismatch/);

    const mutated = structuredClone(checkpoint);
    mutated.observedAt = '2026-09-03T00:00:01.000Z';
    fs.writeFileSync(checkpointPath, canonicalize(mutated));
    const rejected = spawnSync('python3', args, { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /invalid signature/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('witness log parser requires one canonical checkpoint per line', () => {
  const bundle = buildBundle(), verification = verifyBundle(bundle), signer = crypto.generateKeyPairSync('ed25519');
  const checkpoint = createCheckpoint({ bundle, verification, witnessID: 'observer',
    privateKeyPem: signer.privateKey.export({ format: 'pem', type: 'pkcs8' }), sequence: 1 });
  assert.deepEqual(parseCanonicalLog(`${canonicalize(checkpoint)}\n`), [checkpoint]);
  assert.throws(() => parseCanonicalLog(`${JSON.stringify(checkpoint, null, 2)}\n`), /empty lines|invalid JSON|non-canonical/);
});

test('witness CLI observes and independently verifies a bundle', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-witness-'));
  try {
    const bundlePath = path.join(temporary, 'bundle.json');
    const keyPath = path.join(temporary, 'witness.pem');
    const logPath = path.join(temporary, 'checkpoints.jsonl');
    const trustPath = path.join(temporary, 'trust.json');
    const signer = crypto.generateKeyPairSync('ed25519');
    const privateKeyPem = signer.privateKey.export({ format: 'pem', type: 'pkcs8' });
    fs.writeFileSync(bundlePath, canonicalize(buildBundle()));
    fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    const cli = path.join(__dirname, '../bin/mongbas-witness.js');
    const initialized = spawnSync(process.execPath, [cli, 'init-trust', 'mac-observer', keyPath, trustPath], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(fs.statSync(trustPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(trustPath)), {
      schema: TRUST_SCHEMA, witnesses: [{ id: 'mac-observer', ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }],
    });
    const duplicate = spawnSync(process.execPath, [cli, 'init-trust', 'mac-observer', keyPath, trustPath], { encoding: 'utf8' });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /EEXIST/);
    const lockPath = `${logPath}.lock`;
    fs.writeFileSync(lockPath, 'held-by-another-observer', { mode: 0o600 });
    const contended = spawnSync(process.execPath, [cli, 'observe', bundlePath, logPath, 'mac-observer', keyPath], { encoding: 'utf8' });
    assert.equal(contended.status, 1);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'held-by-another-observer');
    fs.unlinkSync(lockPath);
    const observed = spawnSync(process.execPath, [cli, 'observe', bundlePath, logPath, 'mac-observer', keyPath], { encoding: 'utf8' });
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    const verified = spawnSync(process.execPath, [cli, 'verify', logPath, trustPath], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /VALID: 1 witnessed checkpoint/);
    assert.match(verified.stdout, /historyConsistency=verified-from-sequence-1/);
    assert.equal(parseCanonicalLog(fs.readFileSync(logPath, 'utf8'))[0].schema, CHECKPOINT_V2_SCHEMA);
    const bound = spawnSync(process.execPath, [cli, 'verify-bundle', bundlePath, logPath, trustPath, '1'], { encoding: 'utf8' });
    assert.equal(bound.status, 0, bound.stderr);
    assert.match(bound.stdout, /BUNDLE BOUND: sequence=1/);

    const migrationLog = path.join(temporary, 'legacy-checkpoints.jsonl');
    const sourceBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    const sourceVerification = verifyBundle(sourceBundle);
    const legacy = createCheckpoint({ bundle: sourceBundle, verification: sourceVerification, witnessID: 'mac-observer',
      privateKeyPem, sequence: 1, observedAt: '2026-09-02T00:00:00.000Z' });
    fs.writeFileSync(migrationLog, `${canonicalize(legacy)}\n`, { mode: 0o600 });
    const implicit = spawnSync(process.execPath, [cli, 'observe', bundlePath, migrationLog, 'mac-observer', keyPath], { encoding: 'utf8' });
    assert.equal(implicit.status, 1);
    assert.match(implicit.stderr, /explicit migrate-history/);
    const migrated = spawnSync(process.execPath, [cli, 'migrate-history', bundlePath, migrationLog, 'mac-observer', keyPath], { encoding: 'utf8' });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stdout, /consistency starts at sequence=2/);
    const migratedEntries = parseCanonicalLog(fs.readFileSync(migrationLog, 'utf8'));
    assert.deepEqual(migratedEntries.map(entry => entry.schema), [CHECKPOINT_SCHEMA, CHECKPOINT_V2_SCHEMA]);
    assert.equal(verifyCheckpointLog(migratedEntries, JSON.parse(fs.readFileSync(trustPath))).historyVerifiedFromSequence, 2);

    if (process.platform !== 'win32') {
      const exposedKey = path.join(temporary, 'exposed-key.pem');
      fs.copyFileSync(keyPath, exposedKey);
      fs.chmodSync(exposedKey, 0o644);
      const exposedTrust = path.join(temporary, 'exposed-trust.json');
      const rejectedMode = spawnSync(process.execPath, [cli, 'init-trust', 'mode-test', exposedKey, exposedTrust], { encoding: 'utf8' });
      assert.equal(rejectedMode.status, 1);
      assert.match(rejectedMode.stderr, /permissions must not grant group or other access/);
      assert.equal(fs.existsSync(exposedTrust), false);

      const linkedKey = path.join(temporary, 'linked-key.pem');
      fs.symlinkSync(keyPath, linkedKey);
      const linkedTrust = path.join(temporary, 'linked-trust.json');
      const rejectedKeyLink = spawnSync(process.execPath, [cli, 'init-trust', 'link-test', linkedKey, linkedTrust], { encoding: 'utf8' });
      assert.equal(rejectedKeyLink.status, 1);
      assert.match(rejectedKeyLink.stderr, /regular non-symlink file/);

      const logTarget = path.join(temporary, 'log-target.jsonl');
      const linkedLog = path.join(temporary, 'linked-log.jsonl');
      fs.writeFileSync(logTarget, 'sentinel', { mode: 0o600 });
      fs.symlinkSync(logTarget, linkedLog);
      const rejectedLogLink = spawnSync(process.execPath, [cli, 'observe', bundlePath, linkedLog, 'mac-observer', keyPath], { encoding: 'utf8' });
      assert.equal(rejectedLogLink.status, 1);
      assert.match(rejectedLogLink.stderr, /regular non-symlink file/);
      assert.equal(fs.readFileSync(logTarget, 'utf8'), 'sentinel');
    }

    const oversizedLog = path.join(temporary, 'oversized.jsonl');
    fs.writeFileSync(oversizedLog, '', { mode: 0o600 });
    fs.truncateSync(oversizedLog, 16 * 1024 * 1024 + 1);
    const rejectedOversized = spawnSync(process.execPath, [cli, 'verify', oversizedLog, trustPath], { encoding: 'utf8' });
    assert.equal(rejectedOversized.status, 1);
    assert.match(rejectedOversized.stderr, /checkpoint log exceeds 16777216 bytes/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
