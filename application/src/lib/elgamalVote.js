'use strict';
/**
 * lib/elgamalVote.js — 서버 사이드 Exponential ElGamal 암호화 + Disjunctive Chaum-Pedersen ZKP
 *
 * 부스 시연용 seed-votes(투표 자동 주입)에서 사용한다. 클라이언트(utils/crypto.js)와 동일한 방식.
 */
const crypto = require('crypto');

function bufToBigInt(buf) { return BigInt('0x' + Buffer.from(buf).toString('hex')); }
function modPow(b, e, m) { b %= m; let r = 1n; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
function sha256ToBigInt(s) { return BigInt('0x' + crypto.createHash('sha256').update(s).digest('hex')); }
function modInverse(a, m) {
  a = ((a % m) + m) % m; let or = a, r = m, os = 1n, s = 0n;
  while (r !== 0n) { const q = or / r; [or, r] = [r, or - q * r]; [os, s] = [s, os - q * s]; }
  return or !== 1n ? null : ((os % m) + m) % m;
}

const HOMO_BASE = 10000n;

/**
 * @param {{p:string,g:string,y:string}} pub  ElGamal 공개키 (hex)
 * @param {number} candidateIndex  후보 인덱스
 * @param {number} numCandidates   후보 수
 * @returns {{encrypted:string, proof:object}}
 */
function elgamalEncryptWithZKP(pub, candidateIndex, numCandidates) {
  const p = BigInt('0x' + pub.p), g = BigInt('0x' + pub.g), y = BigInt('0x' + pub.y), q = (p - 1n) / 2n;
  const gm = modPow(g, HOMO_BASE ** BigInt(candidateIndex), p);
  let r = bufToBigInt(crypto.randomBytes(32)) % (p - 2n); if (r === 0n) r = 1n;
  const c1 = modPow(g, r, p), c2 = (gm * modPow(y, r, p)) % p;
  const c1h = c1.toString(16), c2h = c2.toString(16);

  const a1s = new Array(numCandidates), a2s = new Array(numCandidates), es = new Array(numCandidates), zs = new Array(numCandidates);
  let k = bufToBigInt(crypto.randomBytes(32)) % q; if (k === 0n) k = 1n;
  let eSum = 0n;
  for (let j = 0; j < numCandidates; j++) {
    if (j === candidateIndex) continue;
    const mj = modPow(g, HOMO_BASE ** BigInt(j), p), mjInv = modInverse(mj, p), c2dm = (c2 * mjInv) % p;
    const ej = bufToBigInt(crypto.randomBytes(32)) % q, zj = bufToBigInt(crypto.randomBytes(32)) % q;
    a1s[j] = ((modPow(g, zj, p) * modPow(modInverse(c1, p), ej, p)) % p).toString(16);
    a2s[j] = ((modPow(y, zj, p) * modPow(modInverse(c2dm, p), ej, p)) % p).toString(16);
    es[j] = ej.toString(16); zs[j] = zj.toString(16); eSum = (eSum + ej) % q;
  }
  a1s[candidateIndex] = modPow(g, k, p).toString(16);
  a2s[candidateIndex] = modPow(y, k, p).toString(16);
  let hi = c1h + '|' + c2h;
  for (let j = 0; j < numCandidates; j++) hi += '|' + a1s[j] + '|' + a2s[j];
  const eTot = sha256ToBigInt(hi) % q, eAct = ((eTot - eSum) % q + q) % q;
  es[candidateIndex] = eAct.toString(16);
  zs[candidateIndex] = ((k + eAct * r) % q).toString(16);
  return { encrypted: `${c1h}:${c2h}`, proof: { a1s, a2s, es, zs } };
}

module.exports = { elgamalEncryptWithZKP };
