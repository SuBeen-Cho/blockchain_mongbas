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
 * nullifierHash = SHA256(voterSecret + electionID)
 *
 * voterSecret은 유권자가 직접 입력하거나 로컬에서 생성합니다.
 * 서버로 전송되지 않으며, 이 값을 잃어버리면 E2E 검증 불가.
 *
 * @param {string} voterSecret - 유권자 비밀값 (로컬 보관)
 * @param {string} electionID  - 선거 ID
 * @returns {Promise<string>} nullifierHash (hex)
 */
export async function computeNullifier(voterSecret, electionID) {
  return sha256(voterSecret + electionID);
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
