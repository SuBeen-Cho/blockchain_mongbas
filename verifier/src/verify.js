'use strict';

const crypto = require('node:crypto');

const P_HEX = [
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1',
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD',
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245',
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED',
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D',
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F',
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D',
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B',
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9',
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510',
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF',
].join('').toLowerCase();
const P = BigInt(`0x${P_HEX}`);
const G = 2n;
const Q = (P - 1n) / 2n;
const HOMOMORPHIC_BASE = 10000n;
const ALGORITHM = 'mongbas-exp-elgamal-scalar-v1';
const THRESHOLD_ALGORITHM = 'mongbas-exp-elgamal-threshold-v2';
const VECTOR_THRESHOLD_ALGORITHM = 'mongbas-exp-elgamal-vector-threshold-v3';

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label}: unexpected or missing fields`);
  }
}

function requireCanonicalBase64(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      Buffer.from(value, 'base64').toString('base64') !== value) throw new Error(`${label}: invalid canonical base64`);
  return Buffer.from(value, 'base64');
}

function validateBundleEnvelope(bundle, schema, tallyAlgorithm, topLevelKeys, { vector = false } = {}) {
  requireExactKeys(bundle, topLevelKeys, 'bundle');
  if (bundle.schema !== schema) throw new Error('schema identifier mismatch');
  requireExactKeys(bundle.algorithms, ['canonicalization', 'hash', 'signature', 'tally'], 'algorithms');
  if (bundle.algorithms.canonicalization !== 'mongbas-canonical-json-v1' || bundle.algorithms.hash !== 'sha-256' ||
      bundle.algorithms.signature !== 'ed25519' || bundle.algorithms.tally !== tallyAlgorithm) {
    throw new Error('algorithm suite mismatch or downgrade');
  }

  requireExactKeys(bundle.configuration, ['electionID', 'candidates', 'signatureThreshold', 'organizations'], 'configuration');
  if (!/^[A-Za-z0-9_.-]{1,256}$/.test(bundle.configuration.electionID)) throw new Error('configuration.electionID invalid');
  const candidates = bundle.configuration.candidates;
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.some(candidate => typeof candidate !== 'string' || candidate.length === 0) ||
      new Set(candidates).size !== candidates.length) throw new Error('configuration.candidates invalid');
  const organizations = bundle.configuration.organizations;
  if (!Array.isArray(organizations) || organizations.length === 0) throw new Error('configuration.organizations invalid');
  const organizationIDs = new Set();
  for (const [index, organization] of organizations.entries()) {
    requireExactKeys(organization, ['id', 'ed25519PublicKeyDer'], `organization[${index}]`);
    if (typeof organization.id !== 'string' || organization.id.length === 0 || organizationIDs.has(organization.id)) throw new Error('duplicate or invalid organization id');
    organizationIDs.add(organization.id);
    const publicKey = crypto.createPublicKey({ key: requireCanonicalBase64(organization.ed25519PublicKeyDer, `organization[${index}].ed25519PublicKeyDer`), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`organization[${index}] key is not Ed25519`);
  }
  if (!Number.isSafeInteger(bundle.configuration.signatureThreshold) || bundle.configuration.signatureThreshold < 1 ||
      bundle.configuration.signatureThreshold > organizationIDs.size) throw new Error('configuration.signatureThreshold invalid');

  requireExactKeys(bundle.provenance, ['gitCommit', 'imageDigest', 'softwareVersion'], 'provenance');
  if (!/^[0-9a-f]{40}$/.test(bundle.provenance.gitCommit) || !/^sha256:[0-9a-f]{64}$/.test(bundle.provenance.imageDigest) ||
      typeof bundle.provenance.softwareVersion !== 'string' || bundle.provenance.softwareVersion.length === 0) throw new Error('provenance invalid');
  requireExactKeys(bundle.publicKey, ['p', 'g', 'y'], 'publicKey');
  requireExactKeys(bundle.bulletinBoard, ['root', 'publishedAt'], 'bulletinBoard');
  if (!/^[0-9a-f]{64}$/.test(bundle.bulletinBoard.root) || !Number.isSafeInteger(bundle.bulletinBoard.publishedAt) || bundle.bulletinBoard.publishedAt < 0) throw new Error('bulletinBoard invalid');
  requireExactKeys(bundle.tally, ['results', 'totalVotes'], 'tally');
  requireExactKeys(bundle.tally.results, candidates, 'tally.results');
  if (!Number.isSafeInteger(bundle.tally.totalVotes) || bundle.tally.totalVotes < 1) throw new Error('tally.totalVotes invalid');
  for (const candidate of candidates) {
    const count = bundle.tally.results[candidate];
    if (!Number.isSafeInteger(count) || count < 0 || (!vector && count >= Number(HOMOMORPHIC_BASE))) throw new Error(`tally result invalid for ${candidate}`);
  }
  if (!Array.isArray(bundle.signatures)) throw new Error('signatures invalid');
  bundle.signatures.forEach((signature, index) => {
    requireExactKeys(signature, ['organizationID', 'signature'], `signature[${index}]`);
    if (typeof signature.organizationID !== 'string' || signature.organizationID.length === 0) throw new Error(`signature[${index}].organizationID invalid`);
    requireCanonicalBase64(signature.signature, `signature[${index}].signature`);
  });
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON supports safe integers only');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`unsupported canonical JSON type: ${typeof value}`);
}

function modPow(base, exponent, modulus) {
  if (exponent < 0n) throw new Error('negative exponent');
  let result = 1n;
  let x = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * x) % modulus;
    x = (x * x) % modulus;
    e >>= 1n;
  }
  return result;
}

function modInverse(value, modulus) {
  let [oldR, r] = [((value % modulus) + modulus) % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  if (oldR !== 1n) return null;
  return ((oldS % modulus) + modulus) % modulus;
}

function parseHex(value, label, { scalar = false, subgroup = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new Error(`${label}: non-canonical lowercase hex`);
  }
  const parsed = BigInt(`0x${value}`);
  if (scalar) {
    if (parsed < 0n || parsed >= Q) throw new Error(`${label}: scalar out of range`);
    return parsed;
  }
  if (parsed <= 1n || parsed >= P) throw new Error(`${label}: group element out of range`);
  if (subgroup && modPow(parsed, Q, P) !== 1n) throw new Error(`${label}: element not in subgroup`);
  return parsed;
}

function candidateMessage(index) {
  return modPow(G, HOMOMORPHIC_BASE ** BigInt(index), P);
}

function verifyBallotProof(publicKeyY, ballot, candidates) {
  const c1 = parseHex(ballot.ciphertext.c1, 'ballot.c1', { subgroup: true });
  const c2 = parseHex(ballot.ciphertext.c2, 'ballot.c2', { subgroup: true });
  const proof = ballot.validityProof;
  for (const name of ['a1s', 'a2s', 'es', 'zs']) {
    if (!Array.isArray(proof?.[name]) || proof[name].length !== candidates.length) {
      throw new Error(`ballot.validityProof.${name}: expected ${candidates.length} entries`);
    }
  }
  let challengeSum = 0n;
  const commitments = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const a1 = parseHex(proof.a1s[index], `a1s[${index}]`, { subgroup: true });
    const a2 = parseHex(proof.a2s[index], `a2s[${index}]`, { subgroup: true });
    const e = parseHex(proof.es[index], `es[${index}]`, { scalar: true });
    const z = parseHex(proof.zs[index], `zs[${index}]`, { scalar: true });
    const messageInverse = modInverse(candidateMessage(index), P);
    const c2DivMessage = (c2 * messageInverse) % P;
    if (modPow(G, z, P) !== (a1 * modPow(c1, e, P)) % P) throw new Error(`ballot proof equation 1 failed at candidate ${index}`);
    if (modPow(publicKeyY, z, P) !== (a2 * modPow(c2DivMessage, e, P)) % P) throw new Error(`ballot proof equation 2 failed at candidate ${index}`);
    challengeSum = (challengeSum + e) % Q;
    commitments.push(a1.toString(16), a2.toString(16));
  }
  const challengeText = [ballot.ciphertext.c1, ballot.ciphertext.c2, ...commitments].join('|');
  const expected = BigInt(`0x${sha256Hex(challengeText)}`) % Q;
  if (challengeSum !== expected) throw new Error('ballot Fiat-Shamir challenge mismatch');
  return { c1, c2 };
}

function encodedTally(results, candidates) {
  let sum = 0n;
  let place = 1n;
  for (const candidate of candidates) {
    const count = results[candidate];
    if (!Number.isSafeInteger(count) || count < 0 || count >= Number(HOMOMORPHIC_BASE)) {
      throw new Error(`result count out of scalar-v1 range for ${candidate}`);
    }
    sum += BigInt(count) * place;
    place *= HOMOMORPHIC_BASE;
  }
  return sum;
}

function verifyDecryptionProof(publicKeyY, aggregate, results, candidates, proof) {
  if (!proof || proof.nullifierHash !== 'HOMOMORPHIC_TALLY') throw new Error('missing homomorphic tally proof');
  if (proof.c1 !== aggregate.c1 || proof.c2 !== aggregate.c2) throw new Error('tally proof ciphertext mismatch');
  const sum = encodedTally(results, candidates);
  const expectedHash = sha256Hex(`homomorphic_sum:${sum}`);
  if (proof.decryptedHash !== expectedHash) throw new Error('tally plaintext hash mismatch');
  const m = modPow(G, sum, P);
  const c1 = parseHex(proof.c1, 'tallyProof.c1', { subgroup: true });
  const c2 = parseHex(proof.c2, 'tallyProof.c2', { subgroup: true });
  const a1 = parseHex(proof.a1, 'tallyProof.a1', { subgroup: true });
  const a2 = parseHex(proof.a2, 'tallyProof.a2', { subgroup: true });
  const e = parseHex(proof.e, 'tallyProof.e', { scalar: true });
  const z = parseHex(proof.z, 'tallyProof.z', { scalar: true });
  const mInverse = modInverse(m, P);
  if (mInverse === null) throw new Error('tally plaintext has no inverse');
  const sharedSecret = (c2 * mInverse) % P;
  const challengeText = [G, publicKeyY, c1, sharedSecret, a1, a2].map((value) => value.toString(16)).join('|');
  const expectedChallenge = BigInt(`0x${sha256Hex(challengeText)}`) % Q;
  if (e !== expectedChallenge) throw new Error('tally Fiat-Shamir challenge mismatch');
  if (modPow(G, z, P) !== (a1 * modPow(publicKeyY, e, P)) % P) throw new Error('tally proof equation 1 failed');
  if (modPow(c1, z, P) !== (a2 * modPow(sharedSecret, e, P)) % P) throw new Error('tally proof equation 2 failed');
}

function lagrangeCoefficientAtZero(index, indexes) {
  let numerator = 1n;
  let denominator = 1n;
  const i = BigInt(index);
  for (const other of indexes) {
    if (other === index) continue;
    const j = BigInt(other);
    numerator = (numerator * j) % Q;
    denominator = (denominator * (j - i)) % Q;
  }
  const inverse = modInverse(denominator, Q);
  if (inverse === null) throw new Error('invalid trustee index set');
  return ((numerator * inverse) % Q + Q) % Q;
}

function combineThresholdValues(values) {
  const indexes = [...values.keys()].sort((a, b) => a - b);
  if (indexes.length < 2 || new Set(indexes).size !== indexes.length) throw new Error('fewer than two unique trustee values');
  let combined = 1n;
  for (const index of indexes) combined = (combined * modPow(values.get(index), lagrangeCoefficientAtZero(index, indexes), P)) % P;
  return combined;
}

function verifyThresholdDecryptions(publicKeyY, aggregate, results, candidates, publicShares, partials) {
  if (!Array.isArray(publicShares) || publicShares.length !== 3 || !Array.isArray(partials) || partials.length < 2) {
    throw new Error('expected three public shares and at least two partial decryptions');
  }
  const configured = new Map(publicShares.map((share) => [share.index, share]));
  if (configured.size !== publicShares.length) throw new Error('duplicate trustee public share index');
  const values = new Map();
  const publicValues = new Map();
  for (const partial of partials) {
    if (values.has(partial.index)) throw new Error(`duplicate partial decryption index: ${partial.index}`);
    const expected = configured.get(partial.index);
    if (!expected || expected.mspID !== partial.mspID || expected.publicKeyY !== partial.publicKeyY) {
      throw new Error(`partial decryption ${partial.index} trustee binding mismatch`);
    }
    const y = parseHex(partial.publicKeyY, `partial[${partial.index}].publicKeyY`, { subgroup: true });
    const value = parseHex(partial.value, `partial[${partial.index}].value`, { subgroup: true });
    const proof = partial.proof;
    if (proof?.c1 !== aggregate.c1 || proof?.c2 !== partial.value) throw new Error(`partial ${partial.index} ciphertext mismatch`);
    const a1 = parseHex(proof.a1, `partial[${partial.index}].a1`, { subgroup: true });
    const a2 = parseHex(proof.a2, `partial[${partial.index}].a2`, { subgroup: true });
    const e = parseHex(proof.e, `partial[${partial.index}].e`, { scalar: true });
    const z = parseHex(proof.z, `partial[${partial.index}].z`, { scalar: true });
    const c1 = parseHex(aggregate.c1, 'aggregate.c1', { subgroup: true });
    const challengeText = [G, y, c1, value, a1, a2].map((item) => item.toString(16)).join('|');
    if (e !== BigInt(`0x${sha256Hex(challengeText)}`) % Q) throw new Error(`partial ${partial.index} Fiat-Shamir challenge mismatch`);
    if (modPow(G, z, P) !== (a1 * modPow(y, e, P)) % P) throw new Error(`partial ${partial.index} proof equation 1 failed`);
    if (modPow(c1, z, P) !== (a2 * modPow(value, e, P)) % P) throw new Error(`partial ${partial.index} proof equation 2 failed`);
    values.set(partial.index, value);
    publicValues.set(partial.index, y);
  }
  if (combineThresholdValues(publicValues) !== publicKeyY) throw new Error('combined trustee public key mismatch');
  const combined = combineThresholdValues(values);
  const c2 = parseHex(aggregate.c2, 'aggregate.c2', { subgroup: true });
  const inverse = modInverse(combined, P);
  if (inverse === null) throw new Error('combined partial has no inverse');
  const actualMessage = (c2 * inverse) % P;
  const expectedMessage = modPow(G, encodedTally(results, candidates), P);
  if (actualMessage !== expectedMessage) throw new Error('threshold-decrypted tally does not match results');
}

function verifyVectorBallotProof(publicKeyY, ballot, candidateCount) {
  if (!Array.isArray(ballot.ciphertextVector) || ballot.ciphertextVector.length !== candidateCount ||
      !Array.isArray(ballot.validityProof?.bitProofs) || ballot.validityProof.bitProofs.length !== candidateCount) {
    throw new Error('invalid vector ballot/proof dimensions');
  }
  let productC1 = 1n, productC2 = 1n;
  ballot.ciphertextVector.forEach((ciphertext, index) => {
    const c1 = parseHex(ciphertext.c1, `ciphertextVector[${index}].c1`, { subgroup: true });
    const c2 = parseHex(ciphertext.c2, `ciphertextVector[${index}].c2`, { subgroup: true });
    const proof = ballot.validityProof.bitProofs[index], messages = [1n, G];
    for (const name of ['a1s', 'a2s', 'es', 'zs']) if (!Array.isArray(proof?.[name]) || proof[name].length !== 2) throw new Error(`bit proof ${index}.${name} invalid`);
    let sum = 0n;
    const domain = `mongbas/vector-v3/bit/${index}`;
    let transcript = `${domain}|${G.toString(16)}|${publicKeyY.toString(16)}|${c1.toString(16)}|${c2.toString(16)}`;
    for (let branch = 0; branch < 2; branch++) {
      const a1 = parseHex(proof.a1s[branch], `bit[${index}].a1[${branch}]`, { subgroup: true });
      const a2 = parseHex(proof.a2s[branch], `bit[${index}].a2[${branch}]`, { subgroup: true });
      const e = parseHex(proof.es[branch], `bit[${index}].e[${branch}]`, { scalar: true });
      const z = parseHex(proof.zs[branch], `bit[${index}].z[${branch}]`, { scalar: true });
      const adjusted = (c2 * modInverse(messages[branch], P)) % P;
      if (modPow(G, z, P) !== (a1 * modPow(c1, e, P)) % P || modPow(publicKeyY, z, P) !== (a2 * modPow(adjusted, e, P)) % P) throw new Error(`bit proof ${index}/${branch} equation failed`);
      sum = (sum + e) % Q;
      transcript += `|${messages[branch].toString(16)}|${a1.toString(16)}|${a2.toString(16)}`;
    }
    if (sum !== BigInt(`0x${sha256Hex(transcript)}`) % Q) throw new Error(`bit proof ${index} challenge mismatch`);
    productC1 = (productC1 * c1) % P; productC2 = (productC2 * c2) % P;
  });
  const result2 = (productC2 * modInverse(G, P)) % P;
  const proof = ballot.validityProof.sumProof;
  const a1 = parseHex(proof?.a1, 'sumProof.a1', { subgroup: true }), a2 = parseHex(proof?.a2, 'sumProof.a2', { subgroup: true });
  const e = parseHex(proof?.e, 'sumProof.e', { scalar: true }), z = parseHex(proof?.z, 'sumProof.z', { scalar: true });
  const transcript = `mongbas/vector-v3/sum|${G.toString(16)}|${publicKeyY.toString(16)}|${productC1.toString(16)}|${result2.toString(16)}|${a1.toString(16)}|${a2.toString(16)}`;
  if (e !== BigInt(`0x${sha256Hex(transcript)}`) % Q || modPow(G, z, P) !== (a1 * modPow(productC1, e, P)) % P ||
      modPow(publicKeyY, z, P) !== (a2 * modPow(result2, e, P)) % P) throw new Error('one-hot sum proof failed');
}

function verifyVectorThresholdDecryptions(publicKeyY, aggregates, results, candidates, publicShares, partials) {
  if (!Array.isArray(aggregates) || aggregates.length !== candidates.length || !Array.isArray(partials) || partials.length < 2) throw new Error('invalid vector aggregates/partials');
  const configured = new Map(publicShares.map((share) => [share.index, share]));
  const publicValues = new Map(), values = aggregates.map(() => new Map());
  for (const partial of partials) {
    if (publicValues.has(partial.index) || !Array.isArray(partial.values) || partial.values.length !== candidates.length || !Array.isArray(partial.proofs) || partial.proofs.length !== candidates.length) throw new Error(`partial ${partial.index} shape/duplicate failure`);
    const expected = configured.get(partial.index);
    if (!expected || expected.mspID !== partial.mspID || expected.publicKeyY !== partial.publicKeyY) throw new Error(`partial ${partial.index} trustee binding mismatch`);
    const y = parseHex(partial.publicKeyY, `partial[${partial.index}].y`, { subgroup: true });
    partial.values.forEach((valueHex, candidateIndex) => {
      const value = parseHex(valueHex, `partial[${partial.index}].value[${candidateIndex}]`, { subgroup: true });
      const c1 = parseHex(aggregates[candidateIndex].c1, `aggregate[${candidateIndex}].c1`, { subgroup: true });
      const proof = partial.proofs[candidateIndex];
      if (proof?.c1 !== aggregates[candidateIndex].c1 || proof?.c2 !== valueHex) throw new Error(`partial ${partial.index}/${candidateIndex} ciphertext mismatch`);
      const a1 = parseHex(proof.a1, 'partial.a1', { subgroup: true }), a2 = parseHex(proof.a2, 'partial.a2', { subgroup: true });
      const e = parseHex(proof.e, 'partial.e', { scalar: true }), z = parseHex(proof.z, 'partial.z', { scalar: true });
      const transcript = [G, y, c1, value, a1, a2].map((item) => item.toString(16)).join('|');
      if (e !== BigInt(`0x${sha256Hex(transcript)}`) % Q || modPow(G, z, P) !== (a1 * modPow(y, e, P)) % P || modPow(c1, z, P) !== (a2 * modPow(value, e, P)) % P) throw new Error(`partial ${partial.index}/${candidateIndex} proof failed`);
      values[candidateIndex].set(partial.index, value);
    });
    publicValues.set(partial.index, y);
  }
  if (combineThresholdValues(publicValues) !== publicKeyY) throw new Error('combined trustee public key mismatch');
  candidates.forEach((candidate, index) => {
    const combined = combineThresholdValues(values[index]);
    const c2 = parseHex(aggregates[index].c2, `aggregate[${index}].c2`, { subgroup: true });
    const count = results[candidate];
    if (!Number.isSafeInteger(count) || count < 0 || (c2 * modInverse(combined, P)) % P !== modPow(G, BigInt(count), P)) throw new Error(`candidate ${candidate} decrypted result mismatch`);
  });
}

function ballotLeaf(ballot) {
	if (ballot.ciphertextVector) return sha256Hex(canonicalize({ candidateCommitment: ballot.candidateCommitment, ciphertextVector: ballot.ciphertextVector, nullifierHash: ballot.nullifierHash, validityProof: ballot.validityProof }));
  return sha256Hex(canonicalize({
    candidateCommitment: ballot.candidateCommitment,
    ciphertext: ballot.ciphertext,
    nullifierHash: ballot.nullifierHash,
    validityProof: ballot.validityProof,
  }));
}

function merkleRoot(ballots) {
  let level = ballots.map(ballotLeaf);
  if (level.length === 0) return sha256Hex('');
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1] ?? level[i];
      next.push(sha256Hex(level[i] + right));
    }
    level = next;
  }
  return level[0];
}

function unsignedBundle(bundle) {
  const clone = structuredClone(bundle);
  delete clone.signatures;
  return clone;
}

function verifySignatures(bundle, payloadBytes) {
  if (!Array.isArray(bundle.signatures) || bundle.signatures.length < bundle.configuration.signatureThreshold) {
    throw new Error('insufficient organization signatures');
  }
  const organizations = new Map(bundle.configuration.organizations.map((org) => [org.id, org]));
  const seen = new Set();
  let valid = 0;
  for (const entry of bundle.signatures) {
    if (seen.has(entry.organizationID)) throw new Error(`duplicate organization signature: ${entry.organizationID}`);
    seen.add(entry.organizationID);
    const organization = organizations.get(entry.organizationID);
    if (!organization) throw new Error(`unknown signing organization: ${entry.organizationID}`);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(organization.ed25519PublicKeyDer, 'base64'), format: 'der', type: 'spki' });
    const signature = Buffer.from(entry.signature, 'base64');
    if (!crypto.verify(null, payloadBytes, publicKey, signature)) throw new Error(`invalid organization signature: ${entry.organizationID}`);
    valid += 1;
  }
  return valid;
}

function lengthPrefixedHash(fields) {
  const hash = crypto.createHash('sha256');
  for (const field of fields) {
    if (typeof field !== 'string') throw new Error('length-prefixed hash field must be a string');
    const bytes = Buffer.from(field, 'utf8');
    hash.update(bytes.length.toString(16).padStart(8, '0'));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function vectorArtifactHash(electionID, candidates, ciphertextVector, validityProof) {
  return sha256Hex(canonicalize({
    schema: 'mongbas-vector-audit-artifact/v1', electionID, candidates,
    encryptedCandidateVector: ciphertextVector, vectorBallotValidityProof: validityProof,
  }));
}

function verifyVectorAuditTrail(bundle, y) {
  const receipts = bundle.vectorBallotReceipts;
  const disclosures = bundle.vectorAuditDisclosures;
  if (!Array.isArray(receipts) || !Array.isArray(disclosures)) throw new Error('audit-or-cast evidence arrays are required');
  const receiptByID = new Map();
  for (const [index, receipt] of receipts.entries()) {
    requireExactKeys(receipt, ['schema', 'ballotID', 'electionID', 'artifactHash', 'status', 'createdAt', 'createdTxID', 'terminalAt', 'terminalTxID'], `vectorBallotReceipts[${index}]`);
    if (receipt.schema !== 'mongbas-vector-ballot-receipt/v1' || !/^[0-9a-f]{64}$/.test(receipt.ballotID) ||
        !/^[0-9a-f]{64}$/.test(receipt.artifactHash) || receipt.electionID !== bundle.configuration.electionID ||
        !['cast', 'audited'].includes(receipt.status) || !Number.isSafeInteger(receipt.createdAt) || !Number.isSafeInteger(receipt.terminalAt) ||
        typeof receipt.createdTxID !== 'string' || !receipt.createdTxID || typeof receipt.terminalTxID !== 'string' || !receipt.terminalTxID ||
        receiptByID.has(receipt.ballotID)) throw new Error(`invalid/duplicate receipt ${index}`);
    receiptByID.set(receipt.ballotID, receipt);
  }
  const castIDs = new Set();
  for (const [index, ballot] of bundle.ballots.entries()) {
    if (!/^[0-9a-f]{64}$/.test(ballot.preparedBallotID) || castIDs.has(ballot.preparedBallotID)) throw new Error(`ballot ${index} prepared ID invalid/duplicate`);
    castIDs.add(ballot.preparedBallotID);
    const receipt = receiptByID.get(ballot.preparedBallotID);
    const hash = vectorArtifactHash(bundle.configuration.electionID, bundle.configuration.candidates, ballot.ciphertextVector, ballot.validityProof);
    if (!receipt || receipt.status !== 'cast' || receipt.artifactHash !== hash) throw new Error(`ballot ${index} cast receipt mismatch`);
  }
  if ([...receiptByID.values()].filter(receipt => receipt.status === 'cast').length !== bundle.ballots.length) throw new Error('orphan cast receipt');
  const disclosedIDs = new Set();
  for (const [index, disclosure] of disclosures.entries()) {
    requireExactKeys(disclosure, ['schema', 'ballotID', 'electionID', 'artifactHash', 'selectedIndex', 'clientNonce', 'randomness',
      'encryptedCandidateVector', 'vectorBallotValidityProof', 'status', 'auditedAt', 'auditedTxID'], `vectorAuditDisclosures[${index}]`);
    if (disclosure.schema !== 'mongbas-vector-audit-disclosure/v1' || disclosure.status !== 'audited' ||
        disclosure.electionID !== bundle.configuration.electionID || !/^[0-9a-f]{64}$/.test(disclosure.clientNonce) ||
        !Array.isArray(disclosure.randomness) || disclosure.randomness.length !== bundle.configuration.candidates.length ||
        !Number.isInteger(disclosure.selectedIndex) || disclosure.selectedIndex < 0 || disclosure.selectedIndex >= bundle.configuration.candidates.length ||
        disclosedIDs.has(disclosure.ballotID)) throw new Error(`invalid/duplicate disclosure ${index}`);
    disclosedIDs.add(disclosure.ballotID);
    const receipt = receiptByID.get(disclosure.ballotID);
    const artifactHash = vectorArtifactHash(disclosure.electionID, bundle.configuration.candidates,
      disclosure.encryptedCandidateVector, disclosure.vectorBallotValidityProof);
    if (!receipt || receipt.status !== 'audited' || receipt.artifactHash !== artifactHash || disclosure.artifactHash !== artifactHash) {
      throw new Error(`disclosure ${index} receipt/artifact mismatch`);
    }
    const expectedBallotID = lengthPrefixedHash(['mongbas/vector-aoc/v1', disclosure.electionID, sha256Hex(disclosure.clientNonce), artifactHash]);
    if (expectedBallotID !== disclosure.ballotID) throw new Error(`disclosure ${index} ballot ID commitment mismatch`);
    verifyVectorBallotProof(y, { ciphertextVector: disclosure.encryptedCandidateVector, validityProof: disclosure.vectorBallotValidityProof }, bundle.configuration.candidates.length);
    disclosure.encryptedCandidateVector.forEach((ciphertext, candidateIndex) => {
      const randomnessHex = disclosure.randomness[candidateIndex];
      if (typeof randomnessHex !== 'string' || !/^[0-9a-f]+$/.test(randomnessHex) || (randomnessHex.length > 1 && randomnessHex.startsWith('0'))) throw new Error(`disclosure ${index} randomness encoding`);
      const randomness = BigInt(`0x${randomnessHex}`);
      if (randomness <= 0n || randomness >= Q) throw new Error(`disclosure ${index} randomness range`);
      const expectedC1 = modPow(G, randomness, P).toString(16);
      const message = candidateIndex === disclosure.selectedIndex ? G : 1n;
      const expectedC2 = (modPow(y, randomness, P) * message % P).toString(16);
      if (ciphertext.c1 !== expectedC1 || ciphertext.c2 !== expectedC2) throw new Error(`disclosure ${index} witness mismatch`);
    });
  }
  if ([...receiptByID.values()].filter(receipt => receipt.status === 'audited').length !== disclosures.length) throw new Error('audited receipt/disclosure count mismatch');
}

function verifyDKGKeyCeremony(bundle) {
  const ceremony = bundle.keyCeremony;
  requireExactKeys(ceremony, ['mode', 'transcript', 'transcriptHash', 'approvals'], 'keyCeremony');
  if (ceremony.mode !== 'dkg-v1') throw new Error('unsupported key ceremony mode');
  const transcript = ceremony.transcript;
  requireExactKeys(transcript, ['schema', 'ceremonyID', 'threshold', 'totalTrustees', 'group', 'participants', 'contributions',
    'publicShares', 'electionPublicKeyY', 'transcriptHash'], 'keyCeremony.transcript');
  if (transcript.schema !== 'mongbas-feldman-dkg-transcript/v1' || transcript.threshold !== 2 || transcript.totalTrustees !== 3) {
    throw new Error('DKG parameters must be 2-of-3 Feldman v1');
  }
  requireExactKeys(transcript.group, ['p', 'g', 'q'], 'keyCeremony.transcript.group');
  if (transcript.group.p !== P_HEX || transcript.group.g !== '2' || transcript.group.q !== Q.toString(16)) throw new Error('DKG group mismatch');
  const hashInput = structuredClone(transcript);
  delete hashInput.transcriptHash;
  const computedHash = sha256Hex(canonicalize(hashInput));
  if (!/^[0-9a-f]{64}$/.test(ceremony.transcriptHash) || transcript.transcriptHash !== computedHash || ceremony.transcriptHash !== computedHash) {
    throw new Error('DKG canonical transcript hash mismatch');
  }
  if (!Array.isArray(transcript.participants) || transcript.participants.length !== 3) throw new Error('DKG participant count mismatch');
  const participants = new Map();
  for (const [offset, participant] of transcript.participants.entries()) {
    requireExactKeys(participant, ['id', 'index', 'transportPublicKeyDer', 'signingPublicKeyDer'], `DKG participant[${offset}]`);
    if (participant.index < 1 || participant.index > 3 || typeof participant.id !== 'string' || participants.has(participant.id)) throw new Error('DKG participant roster invalid');
    const transport = crypto.createPublicKey({ key: requireCanonicalBase64(participant.transportPublicKeyDer, 'DKG transport key'), format: 'der', type: 'spki' });
    const signing = crypto.createPublicKey({ key: requireCanonicalBase64(participant.signingPublicKeyDer, 'DKG signing key'), format: 'der', type: 'spki' });
    if (transport.asymmetricKeyType !== 'x25519' || signing.asymmetricKeyType !== 'ed25519') throw new Error('DKG participant key type invalid');
    participants.set(participant.id, participant);
  }
  const expectedMSPs = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
  for (let index = 1; index <= 3; index += 1) if (participants.get(expectedMSPs[index - 1])?.index !== index) throw new Error('DKG participant MSP/index binding mismatch');
  if (!Array.isArray(ceremony.approvals) || ceremony.approvals.length !== 3 ||
      canonicalize([...ceremony.approvals].sort()) !== canonicalize([...expectedMSPs].sort())) throw new Error('DKG MSP approvals incomplete');
  if (!Array.isArray(transcript.contributions) || transcript.contributions.length !== 3) throw new Error('DKG contribution count mismatch');
  const commitments = new Map();
  for (const [offset, contribution] of transcript.contributions.entries()) {
    requireExactKeys(contribution, ['dealerID', 'commitments', 'contributionHash'], `DKG contribution[${offset}]`);
    requireExactKeys(contribution.commitments, ['constant', 'linear'], `DKG commitments[${offset}]`);
    if (!participants.has(contribution.dealerID) || commitments.has(contribution.dealerID) || !/^[0-9a-f]{64}$/.test(contribution.contributionHash)) throw new Error('DKG contribution metadata invalid');
    commitments.set(contribution.dealerID, {
      constant: parseHex(contribution.commitments.constant, 'DKG constant commitment', { subgroup: true }),
      linear: parseHex(contribution.commitments.linear, 'DKG linear commitment', { subgroup: true }),
    });
  }
  let electionY = 1n;
  for (const id of expectedMSPs) electionY = (electionY * commitments.get(id).constant) % P;
  if (transcript.electionPublicKeyY !== electionY.toString(16) || bundle.publicKey.y !== transcript.electionPublicKeyY) throw new Error('DKG election key commitment equation failed');
  if (!Array.isArray(transcript.publicShares) || transcript.publicShares.length !== 3 || !Array.isArray(bundle.trusteePublicShares)) throw new Error('DKG public shares missing');
  for (let index = 1; index <= 3; index += 1) {
    const published = transcript.publicShares.find(entry => entry.trusteeIndex === index);
    if (!published) throw new Error(`DKG public share ${index} missing`);
    requireExactKeys(published, ['schema', 'ceremonyID', 'trusteeID', 'trusteeIndex', 'publicKeyY'], `DKG public share[${index}]`);
    if (published.schema !== 'mongbas-dkg-public-share/v1' || published.ceremonyID !== transcript.ceremonyID || published.trusteeID !== expectedMSPs[index - 1]) throw new Error(`DKG public share ${index} binding invalid`);
    let expected = 1n;
    for (const id of expectedMSPs) expected = expected * commitments.get(id).constant % P * modPow(commitments.get(id).linear, BigInt(index), P) % P;
    const actual = parseHex(published.publicKeyY, `DKG public share ${index}`, { subgroup: true });
    if (actual !== expected) throw new Error(`DKG public share ${index} commitment equation failed`);
    const bundled = bundle.trusteePublicShares.find(entry => entry.index === index);
    if (!bundled || bundled.mspID !== published.trusteeID || bundled.publicKeyY !== published.publicKeyY) throw new Error(`DKG trustee bundle share ${index} mismatch`);
  }
}

function verifyVectorBundle(bundle) {
  const errors = [];
  const check = (label, fn) => { try { return fn(); } catch (error) { errors.push(`${label}: ${error.message}`); return undefined; } };
  const dkgV5 = bundle?.schema === 'mongbas-election-bundle/v5';
  check('bundle envelope', () => validateBundleEnvelope(bundle, dkgV5 ? 'mongbas-election-bundle/v5' : 'mongbas-election-bundle/v4', VECTOR_THRESHOLD_ALGORITHM,
    ['schema', 'algorithms', 'configuration', 'provenance', 'publicKey', 'trusteePublicShares', 'ballots', 'bulletinBoard',
      'aggregateCiphertextVector', 'tally', 'vectorPartialDecryptions', 'vectorBallotReceipts', 'vectorAuditDisclosures',
	  ...(dkgV5 ? ['keyCeremony'] : []), 'signatures'], { vector: true }));
  if (bundle?.algorithms?.tally !== VECTOR_THRESHOLD_ALGORITHM) errors.push('algorithms.tally: vector-v3 required (downgrade rejected)');
  const candidates = bundle?.configuration?.candidates;
  if (!Array.isArray(candidates) || candidates.length < 2 || new Set(candidates).size !== candidates.length) errors.push('configuration.candidates: invalid');
  if (!Number.isSafeInteger(bundle?.configuration?.signatureThreshold) || bundle.configuration.signatureThreshold < 1 || !Array.isArray(bundle?.configuration?.organizations) || bundle.configuration.organizations.length < bundle.configuration.signatureThreshold) errors.push('configuration signatures: invalid');
  const key = bundle?.publicKey;
  if (key?.p !== P_HEX || key?.g !== '2') errors.push('publicKey: parameters are not RFC 3526 group 14');
  const y = check('publicKey.y', () => parseHex(key?.y, 'publicKey.y', { subgroup: true }));
	if (dkgV5) check('keyCeremony', () => verifyDKGKeyCeremony(bundle));
  const ballots = bundle?.ballots;
  if (!Array.isArray(ballots) || ballots.length === 0) errors.push('ballots: empty or missing');
  const aggregates = Array.isArray(candidates) ? candidates.map(() => ({ c1: 1n, c2: 1n })) : [];
  const seen = new Set();
  if (Array.isArray(ballots) && y && Array.isArray(candidates)) ballots.forEach((ballot, index) => check(`ballots[${index}]`, () => {
    if (!/^[0-9a-f]{64}$/.test(ballot.nullifierHash) || seen.has(ballot.nullifierHash)) throw new Error('invalid/duplicate nullifier');
    seen.add(ballot.nullifierHash);
    const canonicalVector = JSON.stringify(ballot.ciphertextVector);
    if (ballot.candidateCommitment !== sha256Hex(`${bundle.configuration.electionID}|${ballot.nullifierHash}|${canonicalVector}`)) throw new Error('candidate commitment mismatch');
    verifyVectorBallotProof(y, ballot, candidates.length);
    ballot.ciphertextVector.forEach((ciphertext, candidateIndex) => {
      aggregates[candidateIndex].c1 = (aggregates[candidateIndex].c1 * BigInt(`0x${ciphertext.c1}`)) % P;
      aggregates[candidateIndex].c2 = (aggregates[candidateIndex].c2 * BigInt(`0x${ciphertext.c2}`)) % P;
    });
  }));
  if (y && Array.isArray(candidates) && Array.isArray(ballots)) check('vectorAuditTrail', () => verifyVectorAuditTrail(bundle, y));
  const aggregateHex = aggregates.map((value) => ({ c1: value.c1.toString(16), c2: value.c2.toString(16) }));
  if (canonicalize(bundle?.aggregateCiphertextVector) !== canonicalize(aggregateHex)) errors.push('aggregateCiphertextVector: mismatch');
  if (bundle?.tally?.totalVotes !== ballots?.length) errors.push('tally.totalVotes: ballot count mismatch');
  if (Array.isArray(candidates) && bundle?.tally?.results && candidates.reduce((sum, candidate) => sum + (bundle.tally.results[candidate] ?? -1), 0) !== bundle.tally.totalVotes) errors.push('tally.results: sum mismatch');
  if (y && Array.isArray(candidates)) check('vectorPartialDecryptions', () => verifyVectorThresholdDecryptions(y, bundle.aggregateCiphertextVector, bundle.tally.results, candidates, bundle.trusteePublicShares, bundle.vectorPartialDecryptions));
  const root = Array.isArray(ballots) ? check('bulletinBoard.root', () => merkleRoot(ballots)) : undefined;
  if (root && root !== bundle?.bulletinBoard?.root) errors.push('bulletinBoard.root: mismatch');
  const validSignatures = check('signatures', () => verifySignatures(bundle, Buffer.from(canonicalize(unsignedBundle(bundle))))) ?? 0;
  return { valid: errors.length === 0, summary: errors.length ? `${errors.length} verification check(s) failed` : 'all vector-v3 bundle checks passed', errors,
    bundleHash: sha256Hex(canonicalize(bundle)), electionID: bundle?.configuration?.electionID, ballots: ballots?.length ?? 0, validSignatures };
}

function verifyBundleUnchecked(bundle) {
	if (bundle?.schema === 'mongbas-election-bundle/v4' || bundle?.schema === 'mongbas-election-bundle/v5') return verifyVectorBundle(bundle);
  const errors = [];
  let validSignatures = 0;
  const check = (label, fn) => {
    try { return fn(); } catch (error) { errors.push(`${label}: ${error.message}`); return undefined; }
  };
  const thresholdV2 = bundle?.schema === 'mongbas-election-bundle/v2';
  check('bundle envelope', () => validateBundleEnvelope(bundle,
    thresholdV2 ? 'mongbas-election-bundle/v2' : 'mongbas-election-bundle/v1',
    thresholdV2 ? THRESHOLD_ALGORITHM : ALGORITHM,
    thresholdV2
      ? ['schema', 'algorithms', 'configuration', 'provenance', 'publicKey', 'trusteePublicShares', 'ballots', 'bulletinBoard', 'aggregateCiphertext', 'tally', 'partialDecryptions', 'signatures']
      : ['schema', 'algorithms', 'configuration', 'provenance', 'publicKey', 'ballots', 'bulletinBoard', 'aggregateCiphertext', 'tally', 'decryptionProof', 'signatures']));
  if (!thresholdV2 && bundle?.schema !== 'mongbas-election-bundle/v1') errors.push('schema: unsupported bundle schema');
  if (bundle?.algorithms?.tally !== (thresholdV2 ? THRESHOLD_ALGORITHM : ALGORITHM)) errors.push('algorithms.tally: unsupported or downgraded algorithm');
  const candidates = bundle?.configuration?.candidates;
  if (!Array.isArray(candidates) || candidates.length < 2 || new Set(candidates).size !== candidates.length) errors.push('configuration.candidates: invalid or duplicate candidates');
  if (!Number.isSafeInteger(bundle?.configuration?.signatureThreshold) || bundle.configuration.signatureThreshold < 1) errors.push('configuration.signatureThreshold: invalid threshold');
  if (!Array.isArray(bundle?.configuration?.organizations) || bundle.configuration.organizations.length < bundle.configuration.signatureThreshold) errors.push('configuration.organizations: fewer organizations than threshold');
  const key = bundle?.publicKey;
  if (key?.p !== P_HEX || key?.g !== '2') errors.push('publicKey: parameters are not RFC 3526 group 14');
  const y = check('publicKey.y', () => parseHex(key?.y, 'publicKey.y', { subgroup: true }));
  const ballots = bundle?.ballots;
  if (!Array.isArray(ballots) || ballots.length === 0) errors.push('ballots: empty or missing');
  const seenNullifiers = new Set();
  let aggregateC1 = 1n;
  let aggregateC2 = 1n;
  if (Array.isArray(ballots) && y && Array.isArray(candidates)) {
    ballots.forEach((ballot, index) => check(`ballots[${index}]`, () => {
      if (!/^[0-9a-f]{64}$/.test(ballot.nullifierHash)) throw new Error('invalid nullifierHash');
      if (seenNullifiers.has(ballot.nullifierHash)) throw new Error('duplicate nullifierHash');
      seenNullifiers.add(ballot.nullifierHash);
      const expectedCommitment = sha256Hex(`${bundle.configuration.electionID}|${ballot.nullifierHash}|${ballot.ciphertext.c1}:${ballot.ciphertext.c2}`);
      if (ballot.candidateCommitment !== expectedCommitment) throw new Error('candidate commitment mismatch');
      const parsed = verifyBallotProof(y, ballot, candidates);
      aggregateC1 = (aggregateC1 * parsed.c1) % P;
      aggregateC2 = (aggregateC2 * parsed.c2) % P;
    }));
  }
  const aggregate = bundle?.aggregateCiphertext;
  if (aggregate?.c1 !== aggregateC1.toString(16) || aggregate?.c2 !== aggregateC2.toString(16)) errors.push('aggregateCiphertext: does not equal product of ballots');
  if (bundle?.tally?.totalVotes !== ballots?.length) errors.push('tally.totalVotes: does not equal ballot count');
  if (candidates && bundle?.tally?.results) {
    const total = candidates.reduce((sum, candidate) => sum + (bundle.tally.results[candidate] ?? -1), 0);
    if (total !== bundle.tally.totalVotes) errors.push('tally.results: counts do not sum to totalVotes');
  }
  if (y && aggregate && candidates) {
    if (thresholdV2) check('partialDecryptions', () => verifyThresholdDecryptions(y, aggregate, bundle.tally.results, candidates, bundle.trusteePublicShares, bundle.partialDecryptions));
    else check('decryptionProof', () => verifyDecryptionProof(y, aggregate, bundle.tally.results, candidates, bundle.decryptionProof));
  }
  const root = Array.isArray(ballots) ? check('bulletinBoard.root', () => merkleRoot(ballots)) : undefined;
  if (root && bundle?.bulletinBoard?.root !== root) errors.push('bulletinBoard.root: Merkle root mismatch');
  const payloadBytes = Buffer.from(canonicalize(unsignedBundle(bundle)));
  validSignatures = check('signatures', () => verifySignatures(bundle, payloadBytes)) ?? 0;
  const bundleHash = sha256Hex(canonicalize(bundle));
  return {
    valid: errors.length === 0,
    summary: errors.length === 0 ? 'all bundle checks passed' : `${errors.length} verification check(s) failed`,
    errors,
    bundleHash,
    electionID: bundle?.configuration?.electionID,
    ballots: ballots?.length ?? 0,
    validSignatures,
  };
}

function verifyBundle(bundle) {
  try {
    return verifyBundleUnchecked(bundle);
  } catch (error) {
    return { valid: false, summary: 'bundle structure verification failed', errors: [error.message],
      bundleHash: undefined, electionID: bundle?.configuration?.electionID, ballots: Array.isArray(bundle?.ballots) ? bundle.ballots.length : 0, validSignatures: 0 };
  }
}

function verifyBundleBytes(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  let bundle;
  try { bundle = JSON.parse(text); } catch (error) { return { valid: false, summary: 'invalid JSON', errors: [error.message] }; }
  let canonical;
  try { canonical = canonicalize(bundle); } catch (error) { return { valid: false, summary: 'non-canonical data', errors: [error.message] }; }
  if (text.trim() !== canonical) return { valid: false, summary: 'bundle serialization is not canonical', errors: ['input bytes differ from Mongbas canonical JSON v1'] };
  return verifyBundle(bundle);
}

module.exports = {
  ALGORITHM,
  THRESHOLD_ALGORITHM,
	VECTOR_THRESHOLD_ALGORITHM,
  G,
  HOMOMORPHIC_BASE,
  P,
  P_HEX,
  Q,
  canonicalize,
  merkleRoot,
  modInverse,
  modPow,
  sha256Hex,
  unsignedBundle,
  verifyBundle,
  verifyBundleBytes,
};
