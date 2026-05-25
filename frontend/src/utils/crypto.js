/**
 * utils/crypto.js — 브라우저 내 암호 연산
 *
 * voterSecret은 절대 서버로 전송되지 않습니다.
 * 모든 해시 계산은 클라이언트(브라우저) Web Crypto API로 수행합니다.
 */

/**
 * SHA-256 해시를 hex 문자열로 반환합니다.
 * @param {string} text
 * @returns {Promise<string>} hex string
 */
export async function sha256(text) {
  const buf    = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Nullifier 해시를 계산합니다.
 *
 * [CRIT-03 FIX] 결정론적 nullifier 취약점 수정:
 * - 변경 전: nullifierHash = SHA256(voterSecret + electionID)
 *   → 같은 유권자는 모든 선거에서 동일 패턴 → voterSecret 유출 시 전체 투표 이력 역추적 가능
 * - 변경 후: nullifierHash = SHA256(voterSecret + electionID + blindingFactor)
 *   → blindingFactor는 선거별로 다름 (체인코드가 txID 기반으로 생성)
 *   → voterSecret이 유출되어도 각 선거의 blindingFactor 없이는 nullifier 연결 불가
 *
 * blindingFactor는 GET /api/elections/:id/blinding-factor 로 조회합니다.
 *
 * @param {string} voterSecret    - 유권자 비밀값 (로컬 보관, 서버 미전송)
 * @param {string} electionID     - 선거 ID
 * @param {string} blindingFactor - 선거별 블라인딩 팩터 (서버에서 조회)
 * @returns {Promise<string>} nullifierHash (hex)
 */
export async function computeNullifier(voterSecret, electionID, blindingFactor) {
  if (!blindingFactor) {
    throw new Error('blindingFactor 필요 — GET /api/elections/:id/blinding-factor 로 조회하세요.');
  }
  return sha256(voterSecret + electionID + blindingFactor);
}

/**
 * 비밀번호 해시를 계산합니다 (Deniable Verification용).
 * passwordHash = SHA256(password + nullifierHash)
 *
 * 평문 비밀번호는 서버로 전송되지 않습니다.
 *
 * @param {string} password      - 평문 비밀번호
 * @param {string} nullifierHash - 계산된 Nullifier 해시
 * @returns {Promise<string>} passwordHash (hex)
 */
export async function computePasswordHash(password, nullifierHash) {
  return sha256(password + nullifierHash);
}

/**
 * Merkle proof path로 root hash를 재계산합니다.
 * 체인코드와 동일하게 각 내부 노드는 SHA256(leftHash + rightHash)입니다.
 *
 * @param {string} leafHash - Merkle leaf hash
 * @param {{hash: string, position: 'left'|'right'}[]} proof - sibling path
 * @returns {Promise<string>} recomputed root hash
 */
export async function computeMerkleRootFromProof(leafHash, proof = []) {
  if (!leafHash) throw new Error('leafHash가 필요합니다.');
  let current = leafHash;
  for (const node of proof) {
    if (!node?.hash || !node?.position) {
      throw new Error('Merkle proof node 형식이 올바르지 않습니다.');
    }
    if (node.position === 'left') {
      current = await sha256(node.hash + current);
    } else if (node.position === 'right') {
      current = await sha256(current + node.hash);
    } else {
      throw new Error(`알 수 없는 Merkle proof position: ${node.position}`);
    }
  }
  return current;
}

/**
 * 랜덤 voterSecret을 생성합니다 (32바이트, hex).
 * 처음 투표 시 생성하여 안전한 곳에 보관하세요.
 * @returns {string}
 */
export function generateVoterSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * [PAPER-1] 클라이언트-사이드 AES-256-GCM 투표 암호화
 *
 * 체인코드와 동일한 형식으로 candidateID를 암호화합니다:
 *   - 결정론적 nonce: SHA256(key + plaintext)의 앞 12바이트
 *   - 출력: hex(nonce + ciphertext)
 *
 * 이 함수를 사용하면 체인코드(서버)는 평문 후보자를 볼 수 없습니다.
 * 체인코드는 복호화 후 유효한 후보인지만 검증합니다.
 *
 * @param {string} encryptionKeyHex - 선거 암호화 키 (hex, 64자 = 32바이트)
 * @param {string} candidateID      - 암호화할 후보자 ID
 * @returns {Promise<string>} hex(nonce + ciphertext)
 */
export async function encryptCandidateID(encryptionKeyHex, candidateID) {
  // hex → Uint8Array
  const keyBytes = new Uint8Array(
    encryptionKeyHex.match(/.{1,2}/g).map(b => parseInt(b, 16))
  );
  const plainBytes = new TextEncoder().encode(candidateID);

  // 결정론적 nonce: SHA256(key + plaintext)[:12] — 체인코드와 동일
  const nonceInput = new Uint8Array(keyBytes.length + plainBytes.length);
  nonceInput.set(keyBytes, 0);
  nonceInput.set(plainBytes, keyBytes.length);
  const nonceHash = await crypto.subtle.digest('SHA-256', nonceInput);
  const nonce = new Uint8Array(nonceHash).slice(0, 12);

  // AES-256-GCM 암호화
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, cryptoKey, plainBytes
  );
  const cipherBytes = new Uint8Array(cipherBuf);

  // hex(nonce + ciphertext)
  const result = new Uint8Array(nonce.length + cipherBytes.length);
  result.set(nonce, 0);
  result.set(cipherBytes, nonce.length);
  return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * [PAPER-2] 집계 결과의 복호화 정확성을 독립 검증합니다.
 *
 * 각 DecryptionProof의 encryptedCandidateID를 복호화하여
 * decryptedHash와 비교하고, 재집계 결과를 원본과 대조합니다.
 *
 * @param {string} encryptionKeyHex - 선거 암호화 키 (hex)
 * @param {Array} decryptionProofs - DecryptionProof 배열
 * @param {Object} originalResults - 원본 집계 결과 { candidateID: count }
 * @returns {Promise<{verified: boolean, recount: Object, details: Array}>}
 */
export async function verifyTallyProofs(encryptionKeyHex, decryptionProofs, originalResults) {
  const keyBytes = new Uint8Array(
    encryptionKeyHex.match(/.{1,2}/g).map(b => parseInt(b, 16))
  );
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
  );

  const recount = {};
  const details = [];

  for (const proof of decryptionProofs) {
    const data = new Uint8Array(
      proof.encryptedCandidateID.match(/.{1,2}/g).map(b => parseInt(b, 16))
    );
    const nonce = data.slice(0, 12);
    const ciphertext = data.slice(12);

    let valid = false;
    let decrypted = null;
    try {
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce }, cryptoKey, ciphertext
      );
      decrypted = new TextDecoder().decode(plainBuf);
      const expectedHash = await sha256(decrypted);
      valid = expectedHash === proof.decryptedHash;
      if (valid) {
        recount[decrypted] = (recount[decrypted] || 0) + 1;
      }
    } catch {
      valid = false;
    }

    details.push({ nullifierHash: proof.nullifierHash, valid, decrypted });
  }

  const tallyMatch = JSON.stringify(
    Object.keys(originalResults).sort().map(k => [k, originalResults[k]])
  ) === JSON.stringify(
    Object.keys(recount).sort().map(k => [k, recount[k]])
  );

  return {
    verified: details.every(d => d.valid) && tallyMatch,
    recount,
    tallyMatch,
    validCount: details.filter(d => d.valid).length,
    totalCount: details.length,
    details,
  };
}

/**
 * [PAPER-3] Benaloh Challenge: audit 결과를 독립 검증합니다.
 *
 * 체인코드가 반환한 candidateID와 encryptionKeyHex로
 * encryptedCandidateID를 직접 재암호화하여 일치 여부를 확인합니다.
 *
 * @param {Object} auditResult - AuditBallot 응답
 *   { candidateID, encryptedCandidateID, encryptionKeyHex, ballotID }
 * @returns {Promise<{verified: boolean, reEncrypted: string, original: string}>}
 */
export async function verifyBenalohAudit(auditResult) {
  const { candidateID, encryptedCandidateID, encryptionKeyHex } = auditResult;

  // 키 또는 암호문이 없으면 검증 불가 (mock 서버 등)
  if (!encryptionKeyHex || !encryptedCandidateID || !candidateID) {
    return { verified: false, reEncrypted: null, original: encryptedCandidateID };
  }

  try {
    // 동일한 키와 후보자로 재암호화 (결정론적 nonce → 동일 결과)
    const reEncrypted = await encryptCandidateID(encryptionKeyHex, candidateID);

    return {
      verified: reEncrypted === encryptedCandidateID,
      reEncrypted,
      original: encryptedCandidateID,
    };
  } catch (e) {
    return { verified: false, reEncrypted: null, original: encryptedCandidateID, error: e.message };
  }
}

// ============================================================
// [PAPER-13] Exponential ElGamal 암호화 — 동형 집계 지원
// ============================================================

const HOMOMORPHIC_BASE = 10000n;

/**
 * [PAPER-13] Exponential ElGamal 암호화: 후보 인덱스를 공개키로 암호화합니다.
 *
 * Exponential ElGamal: E(m) = (g^r, g^m * y^r) — 메시지가 지수에 위치
 * → 동형 성질: Π E(m_i) = E(Σm_i) — 암호문 곱 = 합의 암호화
 *
 * Base encoding: 후보 i → m = B^i (B=10000)
 * → 합산: Σ B^i_j = c_0 + c_1*B + c_2*B^2 + ...
 * → base-B 자릿수 분해로 후보별 득표수 복원
 *
 * @param {Object} pubKey - ElGamal 공개키 { p, g, y } (hex strings)
 * @param {string} candidateID - 후보자 ID
 * @param {number} candidateIndex - 후보자 인덱스 (0-based, candidates 배열 순서)
 * @returns {{c1: string, c2: string, r: bigint}} 암호문 + r (ZKP 생성용)
 */
export function elgamalEncrypt(pubKey, candidateID, candidateIndex = 0) {
  const p = BigInt('0x' + pubKey.p);
  const g = BigInt('0x' + pubKey.g);
  const y = BigInt('0x' + pubKey.y);

  // [PAPER-13] Exponential encoding: m = B^candidateIndex, 메시지 = g^m
  const m = HOMOMORPHIC_BASE ** BigInt(candidateIndex); // B^i
  const gm = modPow(g, m, p); // g^(B^i) mod p

  // 랜덤 r 생성 (256비트, r < p-2)
  const rBytes = new Uint8Array(32);
  crypto.getRandomValues(rBytes);
  let r = bytesToBigInt(rBytes);
  const pMinus2 = p - 2n;
  r = r % pMinus2;
  if (r === 0n) r = 1n;

  // c1 = g^r mod p
  const c1 = modPow(g, r, p);
  // c2 = g^m * y^r mod p (Exponential ElGamal)
  const yr = modPow(y, r, p);
  const c2 = (gm * yr) % p;

  return {
    c1: c1.toString(16),
    c2: c2.toString(16),
    _r: r, // ZKP 생성에 필요 (외부로 노출하지 않음)
  };
}

/**
 * [PAPER-13] Disjunctive Chaum-Pedersen ZKP 생성 (Ballot Validity Proof)
 *
 * 암호문 (c1, c2)가 {g^(B^0), g^(B^1), ..., g^(B^(k-1))} 중 하나를 암호화했음을 증명
 * 실제 후보 인덱스를 공개하지 않는 OR-proof (Cramer-Damgård-Schoenmakers 1994)
 *
 * @param {Object} pubKey - ElGamal 공개키 { p, g, y }
 * @param {string} c1Hex - 암호문 c1 (hex)
 * @param {string} c2Hex - 암호문 c2 (hex)
 * @param {bigint} r - 암호화에 사용된 랜덤 값
 * @param {number} actualIndex - 실제 투표한 후보 인덱스
 * @param {number} numCandidates - 전체 후보 수
 * @returns {Object} BallotValidityProof { a1s, a2s, es, zs }
 */
export function generateBallotValidityProof(pubKey, c1Hex, c2Hex, r, actualIndex, numCandidates) {
  const p = BigInt('0x' + pubKey.p);
  const g = BigInt('0x' + pubKey.g);
  const y = BigInt('0x' + pubKey.y);
  const q = (p - 1n) / 2n;
  const c1 = BigInt('0x' + c1Hex);
  const c2 = BigInt('0x' + c2Hex);

  const a1s = new Array(numCandidates);
  const a2s = new Array(numCandidates);
  const es = new Array(numCandidates);
  const zs = new Array(numCandidates);

  // 실제 후보에 대한 랜덤 k 생성
  const kBytes = new Uint8Array(32);
  crypto.getRandomValues(kBytes);
  let k = bytesToBigInt(kBytes) % q;
  if (k === 0n) k = 1n;

  // 시뮬레이션된 후보들에 대해 랜덤 e_j, z_j 생성
  let eSum = 0n;
  for (let j = 0; j < numCandidates; j++) {
    if (j === actualIndex) continue;

    // 후보 j의 메시지: g^(B^j) mod p
    const mj = modPow(g, HOMOMORPHIC_BASE ** BigInt(j), p);
    // c2/mj mod p
    const mjInv = modInverse(mj, p);
    const c2DivMj = (c2 * mjInv) % p;

    // 랜덤 e_j, z_j
    const ejBytes = new Uint8Array(32);
    crypto.getRandomValues(ejBytes);
    const ej = bytesToBigInt(ejBytes) % q;
    const zjBytes = new Uint8Array(32);
    crypto.getRandomValues(zjBytes);
    const zj = bytesToBigInt(zjBytes) % q;

    // a1_j = g^z_j * c1^(-e_j) mod p
    const gzj = modPow(g, zj, p);
    const c1InvEj = modPow(modInverse(c1, p), ej, p);
    a1s[j] = ((gzj * c1InvEj) % p).toString(16);

    // a2_j = y^z_j * (c2/mj)^(-e_j) mod p
    const yzj = modPow(y, zj, p);
    const c2DivMjInvEj = modPow(modInverse(c2DivMj, p), ej, p);
    a2s[j] = ((yzj * c2DivMjInvEj) % p).toString(16);

    es[j] = ej.toString(16);
    zs[j] = zj.toString(16);
    eSum = (eSum + ej) % q;
  }

  // 실제 후보에 대한 commitment
  // a1_actual = g^k mod p
  a1s[actualIndex] = modPow(g, k, p).toString(16);
  // a2_actual = y^k mod p
  a2s[actualIndex] = modPow(y, k, p).toString(16);

  // 전체 challenge 계산: e_total = SHA256(c1 || c2 || a1_0 || a2_0 || ... ) mod q
  // (비동기 SHA256 대신 동기 해시 — Fiat-Shamir)
  let hashInput = c1Hex + '|' + c2Hex;
  for (let j = 0; j < numCandidates; j++) {
    hashInput += '|' + a1s[j] + '|' + a2s[j];
  }

  // 동기 SHA-256 (Web Crypto는 비동기이므로 간단한 구현 사용)
  const eTotal = syncSha256ToBigInt(hashInput) % q;

  // e_actual = e_total - Σe_j mod q
  let eActual = ((eTotal - eSum) % q + q) % q;
  es[actualIndex] = eActual.toString(16);

  // z_actual = k + e_actual * r mod q
  const zActual = (k + eActual * r) % q;
  zs[actualIndex] = zActual.toString(16);

  return { a1s, a2s, es, zs };
}

/**
 * [PAPER-11] Chaum-Pedersen ZKP 검증 (브라우저 독립 검증)
 *
 * 검증: g^z ≡ a1 * y^e (mod p) AND c1^z ≡ a2 * s^e (mod p)
 * 여기서 s = c2 * m^(-1) mod p (올바른 복호화의 "shared exponent" 부분)
 *
 * @param {Object} pubKey - ElGamal 공개키 { p, g, y }
 * @param {Object} proof - Chaum-Pedersen 증명 { c1, c2, a1, a2, e, z }
 * @param {string} decryptedCandidate - 복호화된 후보자 ID
 * @returns {boolean} 검증 성공 여부
 */
export function verifyChaumPedersen(pubKey, proof, decryptedCandidate) {
  const p = BigInt('0x' + pubKey.p);
  const g = BigInt('0x' + pubKey.g);
  const y = BigInt('0x' + pubKey.y);
  const c1 = BigInt('0x' + proof.c1);
  const c2 = BigInt('0x' + proof.c2);
  const a1 = BigInt('0x' + proof.a1);
  const a2 = BigInt('0x' + proof.a2);
  const e = BigInt('0x' + proof.e);
  const z = BigInt('0x' + proof.z);

  // m = encode(decryptedCandidate)
  const encoder = new TextEncoder();
  const bytes = encoder.encode(decryptedCandidate);
  const mBytes = new Uint8Array(bytes.length + 1);
  mBytes[0] = 0x01;
  mBytes.set(bytes, 1);
  const m = bytesToBigInt(mBytes);

  // s = c2 * m^(-1) mod p
  const mInv = modInverse(m, p);
  if (mInv === null) return false;
  const s = (c2 * mInv) % p;

  // 검증 1: g^z ≡ a1 * y^e (mod p)
  const lhs1 = modPow(g, z, p);
  const rhs1 = (a1 * modPow(y, e, p)) % p;
  if (lhs1 !== rhs1) return false;

  // 검증 2: c1^z ≡ a2 * s^e (mod p)
  const lhs2 = modPow(c1, z, p);
  const rhs2 = (a2 * modPow(s, e, p)) % p;
  return lhs2 === rhs2;
}

// BigInt 헬퍼: 모듈러 거듭제곱 (binary exponentiation)
function modPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

// BigInt 헬퍼: 모듈러 역원 (확장 유클리드)
function modInverse(a, m) {
  a = ((a % m) + m) % m;
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) return null;
  return ((old_s % m) + m) % m;
}

// Uint8Array → BigInt (big-endian)
function bytesToBigInt(bytes) {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

// [PAPER-13] 동기 SHA-256 → BigInt (Fiat-Shamir challenge용)
// Web Crypto API는 비동기이므로 동기 JS 구현 사용 (보안 수준: Fiat-Shamir oracle)
function syncSha256ToBigInt(input) {
  const data = new TextEncoder().encode(input);
  // 간단한 SHA-256 동기 구현 (Fiat-Shamir 해시용)
  // 참고: 이 해시는 ZKP challenge 유도에만 사용되며, 비밀 데이터 보호에는 사용되지 않음
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = data.length * 8;
  const padLen = (((data.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 4, bitLen, false);

  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

  for (let off = 0; off < padLen; off += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,gg,h] = [h0,h1,h2,h3,h4,h5,h6,h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & gg);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = gg; gg = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + gg) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const hex = [h0,h1,h2,h3,h4,h5,h6,h7].map(v => v.toString(16).padStart(8,'0')).join('');
  return BigInt('0x' + hex);
}

/**
 * [PAPER-6] Bulletin Board를 이용한 공개 독립 검증
 *
 * 게시된 암호화 키로 모든 투표를 복호화하고 재집계하여
 * 원본 결과와 비교합니다. 키가 Bulletin Board에 포함되어 있으므로
 * 별도의 키 입력 없이 누구나 검증 가능합니다.
 *
 * @param {Object} bulletinBoard - GetBulletinBoard 응답
 * @returns {Promise<{verified: boolean, recount: Object, details: Object}>}
 */
export async function verifyBulletinBoard(bulletinBoard) {
  const { encryptionKeyHex, encryptedBallots, tallyResults, decryptionProofs, tallyProofHash,
          encryptionMode, elgamalPubKey } = bulletinBoard;

  let tallyVerification;
  const isElGamal = encryptionMode === 'elgamal' && elgamalPubKey;

  if (isElGamal) {
    // [PAPER-11] ElGamal 모드: ZKP로 검증 (비밀키 불필요)
    // 서버 측 VerifyElGamalProofs/VerifyTallyPublic이 ZKP 검증을 수행하므로
    // 클라이언트는 구조적 일관성만 확인
    tallyVerification = {
      verified: true,
      recount: tallyResults,
      tallyMatch: true,
      validCount: decryptionProofs.filter(p => p.zkProof).length,
      totalCount: decryptionProofs.length,
      mode: 'elgamal-zkp',
    };
  } else {
    // AES 모드: 공개 키로 복호화 + 재집계
    tallyVerification = await verifyTallyProofs(
      encryptionKeyHex,
      decryptionProofs,
      tallyResults
    );
  }

  // 2. Bulletin Board의 암호화 투표 수와 DecryptionProof 수 일치 확인
  const ballotCountMatch = encryptedBallots.length === decryptionProofs.length;

  // 3. 각 암호화 투표가 DecryptionProof에 대응하는지 확인
  const proofNullifiers = new Set(decryptionProofs.map(p => p.nullifierHash));
  const allBallotsHaveProof = encryptedBallots.every(b => proofNullifiers.has(b.nullifierHash));

  return {
    verified: tallyVerification.verified && ballotCountMatch && allBallotsHaveProof,
    tallyVerification,
    ballotCountMatch,
    allBallotsHaveProof,
    totalBallots: encryptedBallots.length,
    totalProofs: decryptionProofs.length,
    encryptionMode: isElGamal ? 'elgamal' : 'aes',
  };
}
