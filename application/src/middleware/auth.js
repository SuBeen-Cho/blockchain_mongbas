/**
 * middleware/auth.js — 유권자 자격 인증 미들웨어 (Idemix 연동 포인트)
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ IDEMIX 연동 시 verifyVoterEligibility() 내부만 교체하면 됩니다 ★
 *
 * ── 환경변수로 동작 제어 ────────────────────────────────────────
 *   IDEMIX_ENABLED=false       기본값: bypass (개발용)
 *   IDEMIX_ENABLED=true        Idemix ZKP 검증 활성화
 *   IDEMIX_SIMULATE_MS=50      실 구현 전 ZKP 연산 시간 시뮬레이션 (ms)
 *   IDEMIX_CACHE_ENABLED=true  인증 결과 캐싱 (최적화 옵션)
 *   IDEMIX_CACHE_TTL_SEC=30    캐시 유효 시간 (초)
 *
 * ── 성능 비교 절차 ──────────────────────────────────────────────
 *   1) 기준선 (현재):  IDEMIX_ENABLED=false
 *   2) Idemix 적용:    IDEMIX_ENABLED=true  IDEMIX_SIMULATE_MS=50
 *   3) 캐시 최적화:    IDEMIX_ENABLED=true  IDEMIX_SIMULATE_MS=50  IDEMIX_CACHE_ENABLED=true
 *   → node benchmark/http-bench.js 로 각 단계 TPS/Latency 측정
 *
 * ── 설계 원칙 ───────────────────────────────────────────────────
 *   - 체인코드(Nullifier) 변경 없음 → 블록체인 레이어 TPS 영향 없음
 *   - 검증은 투표 전 1회만 수행 → Caliper 측정과 독립
 *   - Idemix 연동 후에도 라우터/체인코드 코드 무변경
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ── 환경변수 설정 ───────────────────────────────────────────────
const IDEMIX_ENABLED      = process.env.IDEMIX_ENABLED       === 'true';
const IDEMIX_SIMULATE_MS  = parseInt(process.env.IDEMIX_SIMULATE_MS  || '0',  10);
const CACHE_ENABLED       = process.env.IDEMIX_CACHE_ENABLED  === 'true';
const CACHE_TTL_MS        = parseInt(process.env.IDEMIX_CACHE_TTL_SEC || '30', 10) * 1000;

// ── 인증 결과 캐시 (최적화: 동일 자격증명 재검증 방지) ─────────
const _cache = new Map();

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return entry.result;
}

function _cacheSet(key, result) {
  _cache.set(key, { result, ts: Date.now() });
  // 캐시 크기 제한 (메모리 보호)
  if (_cache.size > 10000) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * 유권자 자격을 검증합니다.
 *
 * ── IDEMIX 연동 시 아래 TODO 블록을 교체하세요 ─────────────────
 *
 * const credential = req.headers['x-idemix-credential'];
 * if (!credential) return { eligible: false };
 *
 * const verified = await fabricCA.verifyIdemixCredential(credential, {
 *   attributeName: 'voterEligible', attributeValue: '1',
 * });
 * return { eligible: verified, anonymous: true, mspId: 'ElectionCommissionMSP' };
 * ──────────────────────────────────────────────────────────────
 */
async function verifyVoterEligibility(req) {
  // ── bypass 모드 (Idemix 미연동) ──────────────────────────────
  if (!IDEMIX_ENABLED) {
    return { eligible: true, anonymous: false, mspId: 'ElectionCommissionMSP', mode: 'bypass' };
  }

  // ── Idemix 모드 ───────────────────────────────────────────────
  // 캐시 키: 자격증명 헤더 or IP (실 구현 시 credential 해시 사용)
  const cacheKey = req.headers['x-idemix-credential'] || req.ip;

  if (CACHE_ENABLED) {
    const cached = _cacheGet(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  // TODO: Idemix 연동 시 이 블록을 실제 ZKP 검증으로 교체
  // 현재: IDEMIX_SIMULATE_MS 환경변수로 ZKP 연산 시간 시뮬레이션
  if (IDEMIX_SIMULATE_MS > 0) {
    await new Promise(r => setTimeout(r, IDEMIX_SIMULATE_MS));
  }

  const result = { eligible: true, anonymous: true, mspId: 'ElectionCommissionMSP', mode: 'idemix' };

  if (CACHE_ENABLED) _cacheSet(cacheKey, result);

  return result;
}

/**
 * Express 미들웨어 — POST /api/vote 앞에 적용됩니다.
 * Idemix 연동 후에도 이 함수와 라우터 코드는 변경 불필요.
 */
async function requireVoterAuth(req, res, next) {
  try {
    const voter = await verifyVoterEligibility(req);
    if (!voter.eligible) {
      return res.status(403).json({ error: '투표 자격이 없습니다. (Idemix 자격증명 필요)' });
    }
    req.voter = voter;
    next();
  } catch (err) {
    res.status(500).json({ error: `인증 처리 오류: ${err.message}` });
  }
}

/**
 * 인증 레이턴시를 직접 측정합니다 (벤치마크 전용 헬퍼).
 * GET /api/bench/auth 엔드포인트에서 사용.
 */
async function measureAuthLatency(req) {
  const start = Date.now();
  const result = await verifyVoterEligibility(req);
  return { ...result, latencyMs: Date.now() - start };
}

/**
 * Idemix 연동 상태 (헬스 체크용)
 */
function idemixStatus() {
  return {
    enabled:      IDEMIX_ENABLED,
    mode:         IDEMIX_ENABLED ? 'idemix' : 'bypass',
    simulateMs:   IDEMIX_SIMULATE_MS,
    cacheEnabled: CACHE_ENABLED,
    cacheTtlSec:  CACHE_TTL_MS / 1000,
    cacheSize:    _cache.size,
  };
}

module.exports = { requireVoterAuth, measureAuthLatency, idemixStatus };
