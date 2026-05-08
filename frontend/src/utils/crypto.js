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
