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
const { generateVectorBallot } = require('../../application/src/lib/vectorElgamal');

function scalar(label) {
  const value = BigInt(`0x${sha256Hex(label)}`) % Q;
  return value === 0n ? 1n : value;
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

function buildBundle() {
  const electionID = 'verifier-known-answer-1';
  const candidates = ['ALICE', 'BOB'];
  const privateKey = scalar('election-private-key');
  const publicKeyY = modPow(G, privateKey, P);
  const selections = [0, 1];
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
  const { publicKey: publicKey1, privateKey: privateKey1 } = crypto.generateKeyPairSync('ed25519');
  const { publicKey: publicKey2, privateKey: privateKey2 } = crypto.generateKeyPairSync('ed25519');
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
    tally: { results: { ALICE: 1, BOB: 1 }, totalVotes: 2 },
    decryptionProof: decryptionProof(privateKey, publicKeyY, aggregate, 1n + HOMOMORPHIC_BASE),
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
  for (const value of [null, {}, { schema: 'mongbas-election-bundle/v3' }, { schema: 'unknown', configuration: null }]) {
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
  bundle.partialDecryptions[0].proof.z = '0';
  assert.equal(verifyBundle(bundle).valid, false, 'tampered threshold proof must fail');
});

function buildVectorBundle() {
  const legacy = buildBundle(), electionID = 'vector-v3-test', candidates = ['A', 'B', 'C'];
  const secret = scalar('vector-secret'), coefficient = scalar('vector-coefficient');
  const shares = [1, 2, 3].map((index) => (secret + coefficient * BigInt(index)) % Q);
  const publicKeyY = modPow(G, secret, P), publicKey = { p: P_HEX, g: '2', y: publicKeyY.toString(16) };
  const ballots = [0, 1, 2, 0].map((selection, index) => {
    const generated = generateVectorBallot(publicKey, selection, candidates.length);
    const nullifierHash = sha256Hex(`vector-nullifier:${index}`);
    return { nullifierHash, candidateCommitment: sha256Hex(`${electionID}|${nullifierHash}|${JSON.stringify(generated.encryptedCandidateVector)}`),
      encryptedCandidateVector: generated.encryptedCandidateVector, vectorBallotValidityProof: generated.vectorBallotValidityProof };
  });
  const aggregates = candidates.map((_, candidateIndex) => ballots.reduce((aggregate, ballot) => ({
    c1: ((BigInt(`0x${aggregate.c1}`) * BigInt(`0x${ballot.encryptedCandidateVector[candidateIndex].c1}`)) % P).toString(16),
    c2: ((BigInt(`0x${aggregate.c2}`) * BigInt(`0x${ballot.encryptedCandidateVector[candidateIndex].c2}`)) % P).toString(16),
  }), { c1: '1', c2: '1' }));
  const mspIDs = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
  const vectorPartials = [0, 1].map((offset) => ({ index: offset + 1, mspID: mspIDs[offset], publicKeyY: modPow(G, shares[offset], P).toString(16),
    values: aggregates.map((aggregate) => thresholdPartial(offset + 1, shares[offset], aggregate, mspIDs[offset]).value),
    proofs: aggregates.map((aggregate) => thresholdPartial(offset + 1, shares[offset], aggregate, mspIDs[offset]).proof) }));
  const source = { schema: 'mongbas-election-bundle-source/v1', encryptionMode: 'elgamal-vector-v3',
    configuration: { ...legacy.configuration, electionID, candidates }, provenance: legacy.provenance, publicKey, ballots,
    tallyResults: { A: 2, B: 1, C: 1 }, totalVotes: 4, aggregateCiphertextVector: aggregates,
    thresholdPublicShares: shares.map((share, offset) => ({ index: offset + 1, mspID: mspIDs[offset], publicKeyY: modPow(G, share, P).toString(16) })),
    vectorPartialDecryptions: vectorPartials, publishedAt: 1 };
  let bundle = buildUnsignedBundle(source);
  assert.equal(bundle.schema, 'mongbas-election-bundle/v3');
  const keys = [crypto.generateKeyPairSync('ed25519'), crypto.generateKeyPairSync('ed25519')];
  bundle.configuration.organizations = keys.map((key, index) => ({ id: index ? 'civil' : 'ec', ed25519PublicKeyDer: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }));
  bundle = signBundle(bundle, 'ec', keys[0].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  bundle = signBundle(bundle, 'civil', keys[1].privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return bundle;
}

test('builds and verifies vector-v3 one-hot ballots and per-candidate threshold decryptions', () => {
  const bundle = buildVectorBundle();
  const result = verifyBundle(bundle);
  assert.equal(result.valid, true, result.errors.join('\n'));
  bundle.ballots[0].validityProof.sumProof.z = '0';
  assert.equal(verifyBundle(bundle).valid, false, 'tampered vector sum proof must fail');
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
  'duplicate ballot': (bundle) => { bundle.ballots.push(structuredClone(bundle.ballots[0])); },
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

test('tamper-corpus CLI emits 15 independently rejected canonical bundles', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-tamper-'));
  try {
    const input = path.join(temporary, 'valid.json');
    const output = path.join(temporary, 'corpus');
    fs.writeFileSync(input, canonicalize(buildVectorBundle()));
    const generated = spawnSync(process.execPath, [path.join(__dirname, '../bin/mongbas-tamper-corpus.js'), input, output], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 15);
    for (const entry of manifest) {
      const result = verifyBundleBytes(fs.readFileSync(path.join(output, entry.filename)));
      assert.equal(result.valid, false, `${entry.name} unexpectedly verified`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
