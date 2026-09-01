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
  const encryptedCandidateVector = [], bitProofs = [];
  let randomnessSum = 0n, productC1 = 1n, productC2 = 1n;
  for (let index = 0; index < candidateCount; index++) {
    const bit = index === selectedIndex ? 1 : 0, r = randomScalar(q);
    const c1 = modPow(g, r, p), c2 = (modPow(y, r, p) * (bit ? g : 1n)) % p;
    const ciphertext = { c1: c1.toString(16), c2: c2.toString(16) };
    encryptedCandidateVector.push(ciphertext);
    bitProofs.push(proveBit(pubKey, ciphertext, r, bit, index));
    randomnessSum = (randomnessSum + r) % q; productC1 = (productC1 * c1) % p; productC2 = (productC2 * c2) % p;
  }
  const result2 = (productC2 * modInverse(g, p)) % p, nonce = randomScalar(q);
  const a1 = modPow(g, nonce, p), a2 = modPow(y, nonce, p), domain = 'mongbas/vector-v3/sum';
  const transcript = `${domain}|${g.toString(16)}|${y.toString(16)}|${productC1.toString(16)}|${result2.toString(16)}|${a1.toString(16)}|${a2.toString(16)}`;
  const e = challenge(transcript, q), z = (nonce + e * randomnessSum) % q;
  return { encryptedCandidateVector, vectorBallotValidityProof: { bitProofs, sumProof: { a1: a1.toString(16), a2: a2.toString(16), e: e.toString(16), z: z.toString(16) } } };
}

module.exports = { generateVectorBallot };
