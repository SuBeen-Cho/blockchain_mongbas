'use strict';

const crypto = require('crypto');

function modPow(base, exponent, modulus) {
  let result = 1n;
  base = ((base % modulus) + modulus) % modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
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
  if (oldR !== 1n) throw new Error('modular inverse does not exist');
  return ((oldS % modulus) + modulus) % modulus;
}

function randomScalar(q) {
  const value = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`) % q;
  return value === 0n ? 1n : value;
}

function challenge(transcript, q) {
  return BigInt(`0x${crypto.createHash('sha256').update(transcript).digest('hex')}`) % q;
}

function proveBit(pubKey, ciphertext, witness, bit, candidateIndex) {
  const p = BigInt(`0x${pubKey.p}`), g = BigInt(`0x${pubKey.g}`), y = BigInt(`0x${pubKey.y}`);
  const q = (p - 1n) / 2n, c1 = BigInt(`0x${ciphertext.c1}`), c2 = BigInt(`0x${ciphertext.c2}`);
  const messages = [1n, g], a1s = new Array(2), a2s = new Array(2), es = new Array(2), zs = new Array(2);
  const nonce = randomScalar(q);
  let simulatedSum = 0n;
  for (let branch = 0; branch < 2; branch++) {
    if (branch === bit) continue;
    const e = randomScalar(q), z = randomScalar(q);
    const adjusted = (c2 * modInverse(messages[branch], p)) % p;
    a1s[branch] = ((modPow(g, z, p) * modPow(modInverse(c1, p), e, p)) % p).toString(16);
    a2s[branch] = ((modPow(y, z, p) * modPow(modInverse(adjusted, p), e, p)) % p).toString(16);
    es[branch] = e.toString(16); zs[branch] = z.toString(16); simulatedSum = (simulatedSum + e) % q;
  }
  a1s[bit] = modPow(g, nonce, p).toString(16);
  a2s[bit] = modPow(y, nonce, p).toString(16);
  const domain = `mongbas/vector-v3/bit/${candidateIndex}`;
  let transcript = `${domain}|${g.toString(16)}|${y.toString(16)}|${c1.toString(16)}|${c2.toString(16)}`;
  for (let branch = 0; branch < 2; branch++) transcript += `|${messages[branch].toString(16)}|${a1s[branch]}|${a2s[branch]}`;
  const e = ((challenge(transcript, q) - simulatedSum) % q + q) % q;
  es[bit] = e.toString(16); zs[bit] = ((nonce + e * witness) % q).toString(16);
  return { a1s, a2s, es, zs };
}

function generateVectorBallot(pubKey, selectedIndex, candidateCount) {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidateCount || candidateCount < 2) {
    throw new Error('invalid vector-v3 selection');
  }
  const p = BigInt(`0x${pubKey.p}`), g = BigInt(`0x${pubKey.g}`), y = BigInt(`0x${pubKey.y}`), q = (p - 1n) / 2n;
  const encryptedCandidateVector = [], bitProofs = [], auditRandomness = [];
	let encryptionNs = 0n, proofNs = 0n;
  let randomnessSum = 0n, productC1 = 1n, productC2 = 1n;
  for (let index = 0; index < candidateCount; index++) {
    const bit = index === selectedIndex ? 1 : 0, r = randomScalar(q);
	auditRandomness.push(r.toString(16));
	const encryptionStart = process.hrtime.bigint();
    const c1 = modPow(g, r, p), c2 = (modPow(y, r, p) * (bit ? g : 1n)) % p;
	encryptionNs += process.hrtime.bigint() - encryptionStart;
    const ciphertext = { c1: c1.toString(16), c2: c2.toString(16) };
    encryptedCandidateVector.push(ciphertext);
	const proofStart = process.hrtime.bigint();
	bitProofs.push(proveBit(pubKey, ciphertext, r, bit, index));
	proofNs += process.hrtime.bigint() - proofStart;
    randomnessSum = (randomnessSum + r) % q; productC1 = (productC1 * c1) % p; productC2 = (productC2 * c2) % p;
  }
  const result2 = (productC2 * modInverse(g, p)) % p, nonce = randomScalar(q);
	const sumProofStart = process.hrtime.bigint();
  const a1 = modPow(g, nonce, p), a2 = modPow(y, nonce, p), domain = 'mongbas/vector-v3/sum';
  const transcript = `${domain}|${g.toString(16)}|${y.toString(16)}|${productC1.toString(16)}|${result2.toString(16)}|${a1.toString(16)}|${a2.toString(16)}`;
  const e = challenge(transcript, q), z = (nonce + e * randomnessSum) % q;
	proofNs += process.hrtime.bigint() - sumProofStart;
  const ballot = { encryptedCandidateVector, vectorBallotValidityProof: { bitProofs, sumProof: { a1: a1.toString(16), a2: a2.toString(16), e: e.toString(16), z: z.toString(16) } },
	  _timings: { encryptionMs: Number(encryptionNs) / 1e6, proofMs: Number(proofNs) / 1e6 } };
  // The audit witness is deliberately non-enumerable so JSON.stringify(ballot)
  // cannot accidentally transmit or log the selected candidate and randomness.
  Object.defineProperty(ballot, '_auditWitness', {
    value: Object.freeze({ selectedIndex, randomness: Object.freeze(auditRandomness) }),
    enumerable: false,
    writable: false,
  });
  return ballot;
}

function parseCanonicalScalar(value, q) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || (value.length > 1 && value.startsWith('0'))) {
    throw new Error('audit randomness must be canonical lowercase hex');
  }
  const scalar = BigInt(`0x${value}`);
  if (scalar <= 0n || scalar >= q) throw new Error('audit randomness is outside the scalar field');
  return scalar;
}

function verifyVectorAuditWitness(pubKey, encryptedCandidateVector, witness) {
  if (!witness || !Number.isInteger(witness.selectedIndex) || !Array.isArray(witness.randomness) ||
      !Array.isArray(encryptedCandidateVector) || encryptedCandidateVector.length < 2 ||
      witness.randomness.length !== encryptedCandidateVector.length ||
      witness.selectedIndex < 0 || witness.selectedIndex >= encryptedCandidateVector.length) {
    return false;
  }
  try {
    const p = BigInt(`0x${pubKey.p}`), g = BigInt(`0x${pubKey.g}`), y = BigInt(`0x${pubKey.y}`), q = (p - 1n) / 2n;
    return encryptedCandidateVector.every((ciphertext, index) => {
      if (!ciphertext || typeof ciphertext.c1 !== 'string' || typeof ciphertext.c2 !== 'string' ||
          !/^[0-9a-f]+$/.test(ciphertext.c1) || !/^[0-9a-f]+$/.test(ciphertext.c2)) return false;
      const randomness = parseCanonicalScalar(witness.randomness[index], q);
      const expectedC1 = modPow(g, randomness, p).toString(16);
      const message = index === witness.selectedIndex ? g : 1n;
      const expectedC2 = (modPow(y, randomness, p) * message % p).toString(16);
      return ciphertext.c1 === expectedC1 && ciphertext.c2 === expectedC2;
    });
  } catch {
    return false;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('artifact contains a non-canonical JSON value');
}

function vectorArtifactHash({ electionID, candidates, encryptedCandidateVector, vectorBallotValidityProof }) {
  if (typeof electionID !== 'string' || electionID.length === 0 || !Array.isArray(candidates) || candidates.length < 2 ||
      candidates.some(candidate => typeof candidate !== 'string' || candidate.length === 0) ||
      !Array.isArray(encryptedCandidateVector) || encryptedCandidateVector.length !== candidates.length ||
      !vectorBallotValidityProof) {
    throw new Error('invalid vector-v3 audit artifact');
  }
  const artifact = {
    schema: 'mongbas-vector-audit-artifact/v1',
    electionID,
    candidates,
    encryptedCandidateVector,
    vectorBallotValidityProof,
  };
  return crypto.createHash('sha256').update(canonicalJson(artifact), 'utf8').digest('hex');
}

module.exports = { generateVectorBallot, verifyVectorAuditWitness, vectorArtifactHash };
