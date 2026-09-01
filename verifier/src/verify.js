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

function ballotLeaf(ballot) {
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

function verifyBundle(bundle) {
  const errors = [];
  let validSignatures = 0;
  const check = (label, fn) => {
    try { return fn(); } catch (error) { errors.push(`${label}: ${error.message}`); return undefined; }
  };
  if (bundle?.schema !== 'mongbas-election-bundle/v1') errors.push('schema: unsupported bundle schema');
  if (bundle?.algorithms?.tally !== ALGORITHM) errors.push('algorithms.tally: unsupported or downgraded algorithm');
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
  if (y && aggregate && candidates) check('decryptionProof', () => verifyDecryptionProof(y, aggregate, bundle.tally.results, candidates, bundle.decryptionProof));
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
