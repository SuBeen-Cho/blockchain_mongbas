/**
 * routes/credential.js — Idemix 자격증명 발급
 *
 * ── 발급 방식 ────────────────────────────────────────────────────
 * [A단계] bypass (IDEMIX_ENABLED=false)
 *   - 자격증명 없이 통과 (성능 기준선)
 *
 * [B단계] PS Signatures on BN254 credential prototype (IDEMIX_IMPL=ps)
 *   - 독립 비교용 구현으로 Fabric Idemix 호환성을 주장하지 않음
 *   - BN254 (BN256) 곡선, 2 pairings per verification
 *   - 비밀키 없이 공개키로만 검증 가능
 *
 * [C단계] BBS+ on BLS12-381 — 개선 Idemix (IDEMIX_IMPL=bbs)
 *   - IRTF CFRG BBS 표준 (draft-irtf-cfrg-bbs-signatures)
 *   - 현재 프로토타입은 proof 검증에 필요한 속성을 모두 전송한다.
 *   - 비연결성·선택적 공개·비교 속도는 별도 보안/성능 검증 없이 주장하지 않는다.
 *
 * 엔드포인트:
 *   POST /api/credential/idemix       — 자격증명 발급
 *   GET  /api/credential/public-key   — 공개키 조회
 *   GET  /api/credential/voters       — 등록 유권자 목록 (개발용)
 */

'use strict';

const crypto  = require('crypto');
const fs      = require('fs');
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
const { logCredentialIssuance, logCredentialFailure } = require('../lib/audit-log');

// PS/BBS 모듈은 필요할 때만 로드
let _psIdemix  = null;
let _bbsIdemix = null;
function getPsIdemix()  { return _psIdemix  || (_psIdemix  = require('../lib/ps-idemix')); }
function getBbsIdemix() { return _bbsIdemix || (_bbsIdemix = require('../lib/bbs-idemix')); }

// ── 등록 유권자 DB (운영 시 실제 DB로 교체) ─────────────────────
const VOTER_REGISTRY = new Map();
const ENABLE_DEMO_CREDENTIALS = process.env.ENABLE_DEMO_CREDENTIALS === 'true';
const registryFile = process.env.VOTER_REGISTRY_FILE || '';
if (registryFile) {
  const records = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (!Array.isArray(records)) throw new Error('VOTER_REGISTRY_FILE은 JSON 배열이어야 합니다.');
  for (const record of records) {
    if (!record.enrollmentID || !/^[0-9a-f]{32,}$/i.test(record.salt || '') || !/^[0-9a-f]{64}$/i.test(record.secretHash || '')) {
      throw new Error(`유권자 레지스트리 레코드 형식 오류: ${record.enrollmentID || '<missing-id>'}`);
    }
    VOTER_REGISTRY.set(record.enrollmentID, {
      salt: record.salt.toLowerCase(), secretHash: record.secretHash.toLowerCase(), eligible: record.eligible === true,
    });
  }
}

// ── [부스 시연용] 데모 유권자 풀 ────────────────────────────────
// 전시 부스에서 다수의 폰이 동시에 투표할 수 있도록 데모 자격증명을 추가한다.
// - demo001..demo1000: 폰/벤치마크별 고유 enrollmentID 배정
// - demo(공용)는 동일 선거에서 항상 같은 nullifier를 만드므로 다중투표에 쓸 수 없다.
// NODE_ENV와 무관하게 ENABLE_DEMO_CREDENTIALS=true일 때만 추가한다.
if (ENABLE_DEMO_CREDENTIALS) {
  for (let i = 1; i <= 5; i++) {
    VOTER_REGISTRY.set(`voter${i}`, { secret: `voter${i}pw`, eligible: true, demo: true });
  }
  for (let i = 1; i <= 1000; i++) {
    const id = `demo${String(i).padStart(3, '0')}`;
    VOTER_REGISTRY.set(id, { secret: `${id}pw`, eligible: true, demo: true });
  }
  VOTER_REGISTRY.set('demo', { secret: 'demopw', eligible: true, demo: true });
}

function verifyEnrollmentSecret(voter, supplied) {
  if (!voter || typeof supplied !== 'string') return false;
  if (voter.demo) {
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(voter.secret);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  if (!voter.salt || !voter.secretHash) return false;
  const actual = crypto.scryptSync(supplied, Buffer.from(voter.salt, 'hex'), 32);
  const expected = Buffer.from(voter.secretHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

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
    .update(`nullifier:${voterID}:${electionID}`)
    .digest('base64url')
    .slice(0, 32);

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
 *   2. 선거별 결정론적 nonce — 재발급해도 동일 nullifier를 생성하도록 서명에 바인딩
 *   3. iat 제거 — payload 최소화 (크기 절감)
 *   4. alg 헤더 포함 — 검증 방식 명시 (HMAC vs Ed25519 구분)
 */
function issueAsymCredential(voterID, electionID) {
  const { privateKey } = getEd25519Keys();

  // 서명된 결합값: 서버/클라이언트가 임의 nullifier로 중복투표 방지를 우회하지 못한다.
  const nonce = crypto
    .createHmac('sha256', CREDENTIAL_SECRET)
    .update(`nullifier:${voterID}:${electionID}`)
    .digest('base64url')
    .slice(0, 32);

  const payload = {
    voterEligible: '1',
    electionID,
    nonce,
    // iat 없음 (크기 최적화, exp만으로 만료 관리)
    exp: Date.now() + CREDENTIAL_TTL_MS,
  };

  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // Ed25519 서명 (deterministic — RFC 8032)
  // 서명 대상은 검증기와 동일하게 "header.payload"로 고정합니다.
  const privKeyObj = crypto.createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' });
  const sigBuf     = crypto.sign(null, Buffer.from(`${header}.${payloadB64}`), privKeyObj);
  const sig        = sigBuf.toString('base64url');

  return `${header}.${payloadB64}.${sig}`;
}

// ── 현재 설정에 따라 발급 방식 선택 ────────────────────────────
async function issueCredentialAuto(voterID, electionID) {
  const nullifierMaterial = crypto
    .createHmac('sha256', CREDENTIAL_SECRET)
    .update(`nullifier:${voterID}:${electionID}`)
    .digest('base64url')
    .slice(0, 32);
  if (IDEMIX_IMPL === 'ps') {
    // [B단계] PS/CL on BN254
    const ps   = getPsIdemix();
    const cred = ps.issueCredential(['1', electionID, String(Date.now() + CREDENTIAL_TTL_MS), nullifierMaterial]);
    return { token: ps.credToToken(cred), credType: 'PS-BN254', sizeBytes: ps.credToToken(cred).length, nullifierMaterial };
  }
  if (IDEMIX_IMPL === 'bbs') {
    // [C단계] BBS+ on BLS12-381
    const bbs  = getBbsIdemix();
    const cred = await bbs.issueCredential(['1', electionID, String(Date.now() + CREDENTIAL_TTL_MS), nullifierMaterial]);
    const tok  = bbs.credToToken(cred);
    return { token: tok, credType: 'BBS+-BLS12381', sizeBytes: tok.length, nullifierMaterial };
  }
  if (ASYM_CRED_ENABLED) {
    const tok = issueAsymCredential(voterID, electionID);
    return { token: tok, credType: 'Ed25519-asym', sizeBytes: Buffer.byteLength(tok, 'utf8'), nullifierMaterial };
  }
  const tok = issueCredential(voterID, electionID);
  return { token: tok, credType: 'HMAC-SHA256', sizeBytes: Buffer.byteLength(tok, 'utf8'), nullifierMaterial };
}

// ── POST /api/credential/idemix ──────────────────────────────────
router.post('/idemix', async (req, res) => {
  const { enrollmentID, enrollmentSecret, electionID } = req.body || {};

  if (!enrollmentID || !enrollmentSecret || !electionID) {
    logCredentialFailure({ electionID, reason: 'missing-fields' });
    return res.status(400).json({
      error: 'enrollmentID, enrollmentSecret, electionID 필수',
    });
  }

  const voter = VOTER_REGISTRY.get(enrollmentID);
  if (!verifyEnrollmentSecret(voter, enrollmentSecret)) {
    logCredentialFailure({ electionID, reason: 'auth-failed' });
    return res.status(401).json({ error: '등록되지 않은 유권자이거나 비밀번호 불일치' });
  }
  if (!voter.eligible) {
    logCredentialFailure({ electionID, reason: 'not-eligible' });
    return res.status(403).json({ error: '투표 자격이 없는 계정입니다.' });
  }

  const { token, credType, sizeBytes, nullifierMaterial } = await issueCredentialAuto(enrollmentID, electionID);

  logCredentialIssuance({
    credentialHash: crypto.createHash('sha256').update(token).digest('hex'),
    electionID,
    credType,
    expiresAt: Date.now() + CREDENTIAL_TTL_MS,
    success: true,
  });

  res.json({
    credential: token,
    expiresIn:  CREDENTIAL_TTL_MS / 1000,
    credType,
    sizeBytes,
    nullifierMaterial,
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
if (ENABLE_DEMO_CREDENTIALS && process.env.NODE_ENV !== 'production') {
  router.get('/voters', (_req, res) => {
    const list = [...VOTER_REGISTRY.entries()].map(([id, v]) => ({
      enrollmentID: id,
      eligible: v.eligible,
    }));
    res.json({ voters: list, note: '운영 환경에서는 이 엔드포인트가 비활성화됩니다.' });
  });
}

module.exports = { router, issueCredential, issueAsymCredential, getEd25519Keys, CREDENTIAL_SECRET, ASYM_CRED_ENABLED };
