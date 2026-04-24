/**
 * routes/credential.js — Idemix 자격증명 발급
 *
 * ── 발급 방식 ────────────────────────────────────────────────────
 * [A단계] bypass (IDEMIX_ENABLED=false)
 *   - 자격증명 없이 통과 (성능 기준선)
 *
 * [B단계] PS Signatures on BN254 — 진짜 Idemix (IDEMIX_IMPL=ps)
 *   - Pointcheval-Sanders 쌍선형 서명 (Hyperledger Fabric Idemix와 동일한 수학)
 *   - BN254 (BN256) 곡선, 2 pairings per verification
 *   - 비밀키 없이 공개키로만 검증 가능
 *
 * [C단계] BBS+ on BLS12-381 — 개선 Idemix (IDEMIX_IMPL=bbs)
 *   - IRTF CFRG BBS 표준 (draft-irtf-cfrg-bbs-signatures)
 *   - 선택적 공개: voterEligible만 공개, electionID/exp는 ZKP로 숨김
 *   - 매 요청마다 새로운 proof → 완전 비연결성
 *   - Rust WASM 구현 → 순수 JS 대비 4-8x 빠름
 *
 * 엔드포인트:
 *   POST /api/credential/idemix       — 자격증명 발급
 *   GET  /api/credential/public-key   — 공개키 조회
 *   GET  /api/credential/voters       — 등록 유권자 목록 (개발용)
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();

const CREDENTIAL_SECRET  = process.env.CREDENTIAL_SECRET  || (() => {
  console.warn('[WARN] CREDENTIAL_SECRET 환경변수 미설정 — 개발용 기본값 사용 중. 운영 환경에서는 반드시 설정하세요.');
  return 'dev-only-credential-secret-' + require('crypto').randomBytes(8).toString('hex');
})();
const CREDENTIAL_TTL_MS  = parseInt(process.env.CREDENTIAL_TTL_SEC || '600', 10) * 1000; // 기본 10분
const ASYM_CRED_ENABLED  = process.env.ASYM_CRED_ENABLED === 'true';
const IDEMIX_IMPL        = process.env.IDEMIX_IMPL        || '';   // 'ps' | 'bbs' | ''
const { getEd25519Keys } = require('../lib/asym-keys');

// PS/BBS 모듈은 필요할 때만 로드
let _psIdemix  = null;
let _bbsIdemix = null;
function getPsIdemix()  { return _psIdemix  || (_psIdemix  = require('../lib/ps-idemix')); }
function getBbsIdemix() { return _bbsIdemix || (_bbsIdemix = require('../lib/bbs-idemix')); }

// ── 등록 유권자 DB (운영 시 실제 DB로 교체) ─────────────────────
const VOTER_REGISTRY = new Map([
  ['voter1', { secret: 'voter1pw', eligible: true }],
  ['voter2', { secret: 'voter2pw', eligible: true }],
  ['voter3', { secret: 'voter3pw', eligible: true }],
  ['voter4', { secret: 'voter4pw', eligible: true }],
  ['voter5', { secret: 'voter5pw', eligible: true }],
  ['admin',  { secret: 'adminpw',  eligible: false }], // 관리자는 투표 불가
]);

// ════════════════════════════════════════════════════════════════
// [B단계] HMAC-SHA256 자격증명 발급
// ════════════════════════════════════════════════════════════════
/**
 * HMAC-SHA256 서명 기반 자격증명 (서버만 검증 가능)
 *   - nonce는 voterID+electionID 조합에서 HMAC 유도 → 결정론적 (같은 입력 = 같은 nonce)
 *   - 서버는 동일 voterID+electionID 조합을 nonce로 역추적 가능
 */
function issueCredential(voterID, electionID) {
  const nonce = crypto
    .createHmac('sha256', CREDENTIAL_SECRET)
    .update(`nonce:${voterID}:${electionID}`)
    .digest('base64url')
    .slice(0, 16);

  const payload = {
    voterEligible: '1',
    electionID,
    nonce,
    iat: Date.now(),
    exp: Date.now() + CREDENTIAL_TTL_MS,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', CREDENTIAL_SECRET)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${sig}`;
}

// ════════════════════════════════════════════════════════════════
// [C단계] Ed25519 비대칭 서명 자격증명 발급
// ════════════════════════════════════════════════════════════════
/**
 * Ed25519 서명 기반 자격증명 (공개키로 누구나 검증 가능)
 *
 * B단계 대비 개선점:
 *   1. 비대칭 키 — 공개키만 있으면 검증 가능, 비밀키 없이도 검증 → 서버 신뢰 불필요
 *   2. 랜덤 nonce — 매 발급마다 fresh random → voterID와 연결 불가 (비연결성 강화)
 *   3. iat 제거 — payload 최소화 (크기 절감)
 *   4. alg 헤더 포함 — 검증 방식 명시 (HMAC vs Ed25519 구분)
 */
function issueAsymCredential(voterID, electionID) {  // eslint-disable-line no-unused-vars
  const { privateKey } = getEd25519Keys();

  // 랜덤 nonce: voterID와 무관 → 서버가 nonce로 voterID 역추적 불가
  const nonce = crypto.randomBytes(12).toString('base64url');

  const payload = {
    voterEligible: '1',
    electionID,
    nonce,
    // iat 없음 (크기 최적화, exp만으로 만료 관리)
    exp: Date.now() + CREDENTIAL_TTL_MS,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // Ed25519 서명 (deterministic — RFC 8032)
  const privKeyObj = crypto.createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' });
  const sigBuf     = crypto.sign(null, Buffer.from(payloadB64), privKeyObj);
  const sig        = sigBuf.toString('base64url');

  // alg 헤더로 검증 방식 명시
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');

  return `${header}.${payloadB64}.${sig}`;
}

// ── 현재 설정에 따라 발급 방식 선택 ────────────────────────────
async function issueCredentialAuto(voterID, electionID) {
  if (IDEMIX_IMPL === 'ps') {
    // [B단계] PS/CL on BN254
    const ps   = getPsIdemix();
    const cred = ps.issueCredential(['1', electionID, String(Date.now() + CREDENTIAL_TTL_MS)]);
    return { token: ps.credToToken(cred), credType: 'PS-BN254', sizeBytes: ps.credToToken(cred).length };
  }
  if (IDEMIX_IMPL === 'bbs') {
    // [C단계] BBS+ on BLS12-381
    const bbs  = getBbsIdemix();
    const cred = await bbs.issueCredential(['1', electionID, String(Date.now() + CREDENTIAL_TTL_MS)]);
    const tok  = bbs.credToToken(cred);
    return { token: tok, credType: 'BBS+-BLS12381', sizeBytes: tok.length };
  }
  if (ASYM_CRED_ENABLED) {
    const tok = issueAsymCredential(voterID, electionID);
    return { token: tok, credType: 'Ed25519-asym', sizeBytes: Buffer.byteLength(tok, 'utf8') };
  }
  const tok = issueCredential(voterID, electionID);
  return { token: tok, credType: 'HMAC-SHA256', sizeBytes: Buffer.byteLength(tok, 'utf8') };
}

// ── POST /api/credential/idemix ──────────────────────────────────
router.post('/idemix', async (req, res) => {
  const { enrollmentID, enrollmentSecret, electionID } = req.body || {};

  if (!enrollmentID || !enrollmentSecret || !electionID) {
    return res.status(400).json({
      error: 'enrollmentID, enrollmentSecret, electionID 필수',
    });
  }

  const voter = VOTER_REGISTRY.get(enrollmentID);
  if (!voter || voter.secret !== enrollmentSecret) {
    return res.status(401).json({ error: '등록되지 않은 유권자이거나 비밀번호 불일치' });
  }
  if (!voter.eligible) {
    return res.status(403).json({ error: '투표 자격이 없는 계정입니다.' });
  }

  const { token, credType, sizeBytes } = await issueCredentialAuto(enrollmentID, electionID);

  res.json({
    credential: token,
    expiresIn:  CREDENTIAL_TTL_MS / 1000,
    credType,
    sizeBytes,
    message:    'Idemix 자격증명 발급 완료. x-idemix-credential 헤더로 투표 시 전송하세요.',
  });
});

// ── GET /api/credential/public-key (C단계 전용) ─────────────────
// 누구나 공개키를 조회해서 credential을 독립 검증 가능
router.get('/public-key', (_req, res) => {
  if (!ASYM_CRED_ENABLED) {
    return res.status(404).json({ error: 'ASYM_CRED_ENABLED=true 모드에서만 사용 가능합니다.' });
  }
  const { publicKey } = getEd25519Keys();
  const pubKeyObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  res.json({
    alg:       'EdDSA',
    publicKey: pubKeyObj.export({ type: 'spki', format: 'der' }).toString('base64url'),
    note:      '이 공개키로 x-idemix-credential 서명을 독립 검증할 수 있습니다.',
  });
});

// ── GET /api/credential/voters (개발·테스트 전용) ───────────────
router.get('/voters', (_req, res) => {
  const list = [...VOTER_REGISTRY.entries()].map(([id, v]) => ({
    enrollmentID: id,
    eligible: v.eligible,
  }));
  res.json({ voters: list, note: '운영 환경에서는 이 엔드포인트를 제거하세요.' });
});

module.exports = { router, issueCredential, issueAsymCredential, getEd25519Keys, CREDENTIAL_SECRET, ASYM_CRED_ENABLED };
