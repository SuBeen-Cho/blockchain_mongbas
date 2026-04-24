/**
 * middleware/auth.js — 다단계 Idemix 유권자 자격 인증 미들웨어
 *
 * ═══════════════════════════════════════════════════════════════
 * 인증 방식 (IDEMIX_IMPL 환경변수로 선택):
 *
 *   [A단계] bypass (IDEMIX_ENABLED=false)
 *     - 인증 없이 통과 (성능 기준선)
 *
 *   [B단계] PS Signatures on BN254 (IDEMIX_IMPL=ps)
 *     - Pointcheval-Sanders 쌍선형 서명
 *     - Hyperledger Fabric Idemix와 동일한 BN254 곡선 + 동일한 서명 방정식
 *     - 검증: e(h, X·∏Yi^mi) == e(σ, g2)  [2 pairings + k G2 mults]
 *
 *   [C단계] BBS+ on BLS12-381 (IDEMIX_IMPL=bbs)
 *     - IRTF CFRG BBS 표준 (draft-irtf-cfrg-bbs-signatures)
 *     - 선택적 공개: voterEligible만 공개
 *     - Rust WASM 구현 → 4-8x 빠름
 *     - 매 요청 새 nonce → 완전 비연결성
 *
 * ── 환경변수 ────────────────────────────────────────────────────
 *   IDEMIX_ENABLED=true/false   인증 활성화
 *   IDEMIX_IMPL=ps|bbs          B/C단계 선택 (기본: HMAC)
 *   IDEMIX_CACHE_ENABLED=true   인증 결과 캐싱 (BBS+는 nonce가 매번 달라서 캐시 무효)
 *   IDEMIX_CACHE_TTL_SEC=30     캐시 유효 시간
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const crypto          = require('crypto');
const { getEd25519Keys } = require('../lib/asym-keys');

// ── 환경변수 설정 ───────────────────────────────────────────────
const IDEMIX_ENABLED     = process.env.IDEMIX_ENABLED       === 'true';
const CACHE_ENABLED      = process.env.IDEMIX_CACHE_ENABLED  === 'true';
// [MED-06 FIX] 기본 TTL 30초 → 5초. 탈취 자격증명 재사용 윈도우 최소화
const CACHE_TTL_MS       = parseInt(process.env.IDEMIX_CACHE_TTL_SEC || '5', 10) * 1000;
const CREDENTIAL_SECRET  = process.env.CREDENTIAL_SECRET     || (() => {
  console.warn('[WARN] CREDENTIAL_SECRET 환경변수 미설정 — 개발용 기본값 사용 중. 운영 환경에서는 반드시 설정하세요.');
  return 'dev-only-credential-secret-' + require('crypto').randomBytes(8).toString('hex');
})();
const ASYM_CRED_ENABLED  = process.env.ASYM_CRED_ENABLED     === 'true';
const IDEMIX_IMPL        = process.env.IDEMIX_IMPL           || '';   // 'ps' | 'bbs' | ''

// PS/BBS 모듈은 필요할 때만 로드
let _psIdemix  = null;
let _bbsIdemix = null;
function getPsIdemix()  { return _psIdemix  || (_psIdemix  = require('../lib/ps-idemix')); }
function getBbsIdemix() { return _bbsIdemix || (_bbsIdemix = require('../lib/bbs-idemix')); }

// ── 인증 결과 캐시 (동일 자격증명 재검증 방지) ──────────────────
const _cache = new Map();

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  // [MED-06 FIX] 자격증명 자체 만료 시 캐시 TTL과 무관하게 즉시 무효화
  // 취소/만료된 자격증명이 캐시에서 계속 유효로 반환되는 문제 수정
  if (entry.result.expUnix && Math.floor(Date.now() / 1000) > entry.result.expUnix) {
    _cache.delete(key);
    return null;
  }
  return entry.result;
}

function _cacheSet(key, result) {
  _cache.set(key, { result, ts: Date.now() });
  if (_cache.size > 10000) {
    _cache.delete(_cache.keys().next().value); // 가장 오래된 항목 제거
  }
}

// ── [C단계] Ed25519 비대칭 자격증명 검증 ────────────────────────
/**
 * Ed25519 서명 검증 (공개키 기반 — 서버 비밀키 불필요)
 *
 * credential 형식: header_b64.payload_b64.signature_b64
 * 공개키는 credential.js에서 getEd25519Keys()로 가져옴
 */
function verifyAsymCredential(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'Ed25519 credential 형식 오류 (header.payload.sig 필요)' };

    const [headerB64, payloadB64, sigB64] = parts;

    // 헤더 확인
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    if (header.alg !== 'EdDSA') return { valid: false, reason: `알 수 없는 알고리즘: ${header.alg}` };

    const { publicKey } = getEd25519Keys();
    const pubKeyObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });

    // Ed25519 서명 검증 (서명 대상: "header.payload")
    const message = Buffer.from(`${headerB64}.${payloadB64}`);
    const sigBuf  = Buffer.from(sigB64, 'base64url');
    const valid   = crypto.verify(null, message, pubKeyObj, sigBuf);
    if (!valid) return { valid: false, reason: 'Ed25519 서명 검증 실패' };

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp)          return { valid: false, reason: '자격증명 만료' };
    if (payload.voterEligible !== '1')     return { valid: false, reason: '투표 자격 속성 없음' };

    // [CRIT-01/02 FIX] expUnix/credType 포함하여 반환
    return {
      valid: true,
      electionID: payload.electionID,
      expUnix: Math.floor(payload.exp / 1000),
      credType: 'ed25519',
    };
  } catch (e) {
    return { valid: false, reason: `Ed25519 파싱 오류: ${e.message}` };
  }
}

// ── [B단계] HMAC-SHA256 자격증명 검증 ───────────────────────────
/**
 * HMAC-SHA256 서명 + 만료 + 속성 검증
 * voterID는 검증 결과에 포함되지 않음 → 호출부에 신원 노출 없음
 */
function verifyCredential(token) {
  try {
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx < 1) return { valid: false, reason: '잘못된 credential 형식' };

    const payloadB64 = token.slice(0, dotIdx);
    const sig        = token.slice(dotIdx + 1);

    // timing-safe 서명 검증
    const expected = crypto
      .createHmac('sha256', CREDENTIAL_SECRET)
      .update(payloadB64)
      .digest('base64url');

    const sigBuf = Buffer.from(sig,      'base64url');
    const expBuf = Buffer.from(expected, 'base64url');

    if (sigBuf.length !== expBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: '서명 검증 실패' };
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    if (Date.now() > payload.exp) {
      return { valid: false, reason: '자격증명 만료' };
    }
    if (payload.voterEligible !== '1') {
      return { valid: false, reason: '투표 자격 속성 없음' };
    }

    // [CRIT-01/02 FIX] expUnix/credType 포함하여 반환
    return {
      valid: true,
      electionID: payload.electionID,
      expUnix: Math.floor(payload.exp / 1000),
      credType: 'hmac',
    };
  } catch (e) {
    return { valid: false, reason: `파싱 오류: ${e.message}` };
  }
}

// ── [B단계] PS/CL 자격증명 검증 ─────────────────────────────────
function verifyPsCredential(token) {
  const ps   = getPsIdemix();
  const cred = ps.tokenToCred(token);
  if (!cred) return { valid: false, reason: 'PS credential 파싱 오류' };
  return ps.verifyCredential(cred);
}

// ── [C단계] BBS+ 자격증명 검증 ──────────────────────────────────
async function verifyBbsCredential(token) {
  const bbs  = getBbsIdemix();
  const cred = bbs.tokenToCred(token);
  if (!cred) return { valid: false, reason: 'BBS+ credential 파싱 오류' };
  return bbs.verifyCredential(cred);
}

// ── 유권자 자격 검증 (핵심 함수) ────────────────────────────────
async function verifyVoterEligibility(req) {
  // bypass 모드 (개발/테스트용)
  // [CRIT-01/02 FIX] bypass도 credType/expUnix/credHash 포함 — vote.js 가 transient 구성에 사용
  if (!IDEMIX_ENABLED) {
    return {
      eligible: true, anonymous: false, mspId: 'ElectionCommissionMSP', mode: 'bypass',
      credType: 'bypass',
      expUnix:  Math.floor(Date.now() / 1000) + 3600,
      credHash: crypto.createHash('sha256').update('bypass').digest('hex'),
    };
  }

  // Idemix 모드: x-idemix-credential 헤더 필수
  const credHeader = req.headers['x-idemix-credential'] || '';

  if (!credHeader) {
    return { eligible: false, reason: 'x-idemix-credential 헤더 누락. /api/credential/idemix 로 발급하세요.' };
  }

  // ── [B단계] PS 서명 검증 ────────────────────────────────────────
  if (IDEMIX_IMPL === 'ps') {
    const verified = verifyPsCredential(credHeader);
    if (!verified.valid) return { eligible: false, reason: verified.reason };
    // [CRIT-01/02 FIX] credType/expUnix/credHash 포함
    return {
      eligible:   true,
      anonymous:  true,
      mspId:      'ElectionCommissionMSP',
      mode:       'idemix-ps',
      electionID: verified.electionID,
      credType:   'ps',
      expUnix:    verified.expUnix || Math.floor(Date.now() / 1000) + 300,
      credHash:   crypto.createHash('sha256').update(credHeader).digest('hex'),
    };
  }

  // ── [C단계] BBS+ Proof 생성 + 검증 ─────────────────────────────
  if (IDEMIX_IMPL === 'bbs') {
    const verified = await verifyBbsCredential(credHeader);
    if (!verified.valid) return { eligible: false, reason: verified.reason };
    // [CRIT-01/02 FIX] credType/expUnix/credHash 포함
    return {
      eligible:   true,
      anonymous:  true,
      mspId:      'ElectionCommissionMSP',
      mode:       'idemix-bbs',
      electionID: verified.electionID,
      credType:   'bbs',
      expUnix:    verified.expUnix || Math.floor(Date.now() / 1000) + 300,
      credHash:   crypto.createHash('sha256').update(credHeader).digest('hex'),
    };
  }

  // ── [기존] 캐시 키: credential 해시 ────────────────────────────
  const cacheKey = crypto.createHash('sha256')
    .update(credHeader)
    .digest('hex')
    .slice(0, 32);

  if (CACHE_ENABLED) {
    const cached = _cacheGet(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  // ── 서명 검증: Ed25519 또는 HMAC ────────────────────────────────
  const verified = ASYM_CRED_ENABLED
    ? verifyAsymCredential(credHeader)
    : verifyCredential(credHeader);

  if (!verified.valid) {
    return { eligible: false, reason: verified.reason };
  }

  // [CRIT-01/02 FIX] credType/expUnix/credHash 포함
  const result = {
    eligible:    true,
    anonymous:   true,
    mspId:       'ElectionCommissionMSP',
    mode:        'idemix',
    electionID:  verified.electionID,
    credType:    verified.credType  || (ASYM_CRED_ENABLED ? 'ed25519' : 'hmac'),
    expUnix:     verified.expUnix  || Math.floor(Date.now() / 1000) + 300,
    credHash:    crypto.createHash('sha256').update(credHeader).digest('hex'),
  };

  if (CACHE_ENABLED) _cacheSet(cacheKey, result);
  return result;
}

// ── Express 미들웨어 ─────────────────────────────────────────────
async function requireVoterAuth(req, res, next) {
  try {
    const voter = await verifyVoterEligibility(req);
    if (!voter.eligible) {
      return res.status(403).json({
        error: '투표 자격이 없습니다.',
        reason: voter.reason,
        hint: 'POST /api/credential/idemix 로 자격증명을 먼저 발급받으세요.',
      });
    }
    req.voter = voter;
    next();
  } catch (err) {
    res.status(500).json({ error: `인증 처리 오류: ${err.message}` });
  }
}

// ── 벤치마크 전용 헬퍼 ─────────────────────────────────────────
async function measureAuthLatency(req) {
  const start  = Date.now();
  const result = await verifyVoterEligibility(req);
  return { ...result, latencyMs: Date.now() - start };
}

// ── 헬스 체크용 상태 반환 ───────────────────────────────────────
function idemixStatus() {
  let impl;
  if (IDEMIX_IMPL === 'ps')  impl = 'PS-BN254 (B단계: 진짜 Idemix CL)';
  else if (IDEMIX_IMPL === 'bbs') impl = 'BBS+-BLS12381 (C단계: 개선 Idemix)';
  else if (ASYM_CRED_ENABLED)     impl = 'Ed25519-asymmetric';
  else                             impl = 'HMAC-SHA256';

  return {
    enabled:      IDEMIX_ENABLED,
    mode:         IDEMIX_ENABLED ? `idemix-${IDEMIX_IMPL || 'hmac'}` : 'bypass',
    impl,
    idemixImpl:   IDEMIX_IMPL || 'hmac',
    asymEnabled:  ASYM_CRED_ENABLED,
    cacheEnabled: CACHE_ENABLED,
    cacheTtlSec:  CACHE_TTL_MS / 1000,
    cacheSize:    _cache.size,
  };
}

module.exports = { requireVoterAuth, measureAuthLatency, idemixStatus, verifyCredential, verifyAsymCredential };
