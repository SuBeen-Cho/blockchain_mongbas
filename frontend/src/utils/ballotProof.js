// Browser port of verifier/src/verify.js verifyVectorBallotProof (vector-v3
// one-hot proof). Returns a per-step report for the verification screen
// instead of throwing, so the UI can show exactly which check passed.

const big = (hex) => BigInt(`0x${hex}`);
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

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @returns {Promise<{ ok: boolean, bits: boolean[], sum: boolean }>}
 *   bits[i]: candidate i holds 0 or 1;  sum: exactly one candidate holds 1.
 */
export async function verifyVectorBallotProofBrowser(pubKey, ciphertextVector, validityProof) {
  const P = big(pubKey.p), G = big(pubKey.g), Y = big(pubKey.y), Q = (P - 1n) / 2n;
  const gInverse = modPow(G, P - 2n, P);
  const inverses = [1n, gInverse];
  const report = { ok: false, bits: [], sum: false };
  try {
    let productC1 = 1n, productC2 = 1n;
    for (let index = 0; index < ciphertextVector.length; index++) {
      const c1 = big(ciphertextVector[index].c1), c2 = big(ciphertextVector[index].c2);
      const proof = validityProof.bitProofs[index];
      let sum = 0n, ok = true;
      let transcript = `mongbas/vector-v3/bit/${index}|${G.toString(16)}|${Y.toString(16)}|${c1.toString(16)}|${c2.toString(16)}`;
      for (let branch = 0; branch < 2; branch++) {
        const a1 = big(proof.a1s[branch]), a2 = big(proof.a2s[branch]);
        const e = big(proof.es[branch]), z = big(proof.zs[branch]);
        const adjusted = (c2 * inverses[branch]) % P;
        if (modPow(G, z, P) !== (a1 * modPow(c1, e, P)) % P || modPow(Y, z, P) !== (a2 * modPow(adjusted, e, P)) % P) ok = false;
        sum = (sum + e) % Q;
        transcript += `|${(branch ? G : 1n).toString(16)}|${a1.toString(16)}|${a2.toString(16)}`;
      }
      if (sum !== big(await sha256Hex(transcript)) % Q) ok = false;
      report.bits.push(ok);
      productC1 = (productC1 * c1) % P;
      productC2 = (productC2 * c2) % P;
    }
    const result2 = (productC2 * inverses[1]) % P;
    const s = validityProof.sumProof;
    const a1 = big(s.a1), a2 = big(s.a2), e = big(s.e), z = big(s.z);
    const transcript = `mongbas/vector-v3/sum|${G.toString(16)}|${Y.toString(16)}|${productC1.toString(16)}|${result2.toString(16)}|${a1.toString(16)}|${a2.toString(16)}`;
    report.sum = e === big(await sha256Hex(transcript)) % Q &&
      modPow(G, z, P) === (a1 * modPow(productC1, e, P)) % P &&
      modPow(Y, z, P) === (a2 * modPow(result2, e, P)) % P;
    report.ok = report.sum && report.bits.every(Boolean) && report.bits.length === ciphertextVector.length;
  } catch {
    report.ok = false;
  }
  return report;
}
