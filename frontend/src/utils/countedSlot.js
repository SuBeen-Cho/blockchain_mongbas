// Deniable counted slot (panicPolicy "deniable-slot-v1"), browser + Node (>=20).
//
// The device builds the next counted slot C' and a disjunctive Chaum-Pedersen
// proof that C' re-encrypts EITHER the visible ballot V (normal vote) OR the
// previous counted slot (panic vote). Verifiers learn which branch is true only
// by breaking DDH. Must stay byte-compatible with chaincode deniable_slot.go.

export const PANIC_POLICY_DENIABLE_SLOT = 'deniable-slot-v1';

const big = (hex) => BigInt(`0x${hex}`);
const hex = (value) => value.toString(16);
const mod = (a, m) => ((a % m) + m) % m;

function modPow(base, exponent, modulus) {
  let result = 1n;
  base = mod(base, modulus);
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

function modInverse(value, modulus) {
  let [oldR, r] = [mod(value, modulus), modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('modular inverse does not exist');
  return mod(oldS, modulus);
}

function randomScalar(q) {
  const bytes = new Uint8Array(64);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  value %= q;
  return value === 0n ? 1n : value;
}

async function challenge(electionID, nullifierHash, groups, commitments, q) {
  const parts = ['mongbas-deniable-slot-v1', electionID, nullifierHash];
  for (const group of groups) for (const ct of group) parts.push(hex(big(ct.c1)), hex(big(ct.c2)));
  for (const t of commitments) parts.push(hex(t));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  let value = 0n;
  for (const b of new Uint8Array(digest)) value = (value << 8n) | BigInt(b);
  return value % q;
}

function groupParams(pubKey) {
  const p = big(pubKey.p);
  return { p, q: (p - 1n) / 2n, g: big(pubKey.g), y: big(pubKey.y) };
}

export function zeroSlot(n) {
  return Array.from({ length: n }, () => ({ c1: '1', c2: '1' }));
}

function quotient(next, base, p) {
  return {
    a: (big(next.c1) * modInverse(big(base.c1), p)) % p,
    b: (big(next.c2) * modInverse(big(base.c2), p)) % p,
  };
}

/**
 * @param {object} args
 * @param {{p:string,g:string,y:string}} args.pubKey election ElGamal key (hex)
 * @param {Array<{c1:string,c2:string}>} args.visible this cast's vote vector
 * @param {Array<{c1:string,c2:string}>|null} args.previous current counted slot (null on first cast)
 * @param {'normal'|'panic'} args.branch
 */
export async function buildCountedSlot({ pubKey, electionID, nullifierHash, visible, previous, branch }) {
  const { p, q, g, y } = groupParams(pubKey);
  const n = visible.length;
  const old = previous && previous.length === n ? previous : zeroSlot(n);
  const real = branch === 'panic' ? 1 : 0;
  const fake = 1 - real;
  const bases = [visible, old];

  const s = Array.from({ length: n }, () => randomScalar(q));
  const vector = bases[real].map((ct, k) => ({
    c1: hex((big(ct.c1) * modPow(g, s[k], p)) % p),
    c2: hex((big(ct.c2) * modPow(y, s[k], p)) % p),
  }));

  const cFake = randomScalar(q);
  const z = [[], []];
  const w = [];
  const commitments = [[], []];
  for (let k = 0; k < n; k++) {
    w[k] = randomScalar(q);
    commitments[real].push(modPow(g, w[k], p), modPow(y, w[k], p));
    const zf = randomScalar(q);
    z[fake][k] = zf;
    const { a, b } = quotient(vector[k], bases[fake][k], p);
    const negC = q - cFake;
    commitments[fake].push((modPow(g, zf, p) * modPow(a, negC, p)) % p, (modPow(y, zf, p) * modPow(b, negC, p)) % p);
  }
  const c = await challenge(electionID, nullifierHash, [visible, old, vector], [...commitments[0], ...commitments[1]], q);
  const cReal = mod(c - cFake, q);
  for (let k = 0; k < n; k++) z[real][k] = mod(w[k] + cReal * s[k], q);
  const cs = [];
  cs[real] = cReal;
  cs[fake] = cFake;
  return {
    vector,
    proof: { schema: PANIC_POLICY_DENIABLE_SLOT, c: cs.map(hex), z: z.map((row) => row.map(hex)) },
  };
}

export async function verifyCountedSlot({ pubKey, electionID, nullifierHash, visible, previous, next, proof }) {
  const { p, q, g, y } = groupParams(pubKey);
  const n = visible.length;
  const old = previous && previous.length === n ? previous : zeroSlot(n);
  if (proof?.schema !== PANIC_POLICY_DENIABLE_SLOT || next.length !== n) return false;
  const cs = proof.c.map(big);
  const commitments = [];
  [visible, old].forEach((base, j) => {
    for (let k = 0; k < n; k++) {
      const { a, b } = quotient(next[k], base[k], p);
      const zz = big(proof.z[j][k]);
      const negC = q - cs[j];
      commitments.push((modPow(g, zz, p) * modPow(a, negC, p)) % p, (modPow(y, zz, p) * modPow(b, negC, p)) % p);
    }
  });
  const c = await challenge(electionID, nullifierHash, [visible, old, next], commitments, q);
  return mod(cs[0] + cs[1], q) === c;
}
