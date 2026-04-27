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
 * 랜덤 voterSecret을 생성합니다 (32바이트, hex).
 * 처음 투표 시 생성하여 안전한 곳에 보관하세요.
 * @returns {string}
 */
export function generateVoterSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
