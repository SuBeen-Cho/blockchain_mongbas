/**
 * middleware/auth.js — 유권자 자격 인증 미들웨어 (Idemix 연동 포인트)
 *
 * ═══════════════════════════════════════════════════════════════
 * ★ IDEMIX 연동 시 이 파일만 수정하면 됩니다 ★
 *
 * 현재 구현: 자격 검증 없이 모든 요청 허용 (개발/시연용)
 * Idemix 연동 후: verifyVoterEligibility() 내부를 교체
 *
 * 설계 원칙 — Idemix 추가 시 성능에 영향 없는 이유:
 *   1. 체인코드(Nullifier)는 변경 불필요 → 블록체인 레이어 성능 무변화
 *   2. 인증 검증은 이 파일 한 곳에서만 발생 → 격리됨
 *   3. Idemix ZKP 연산은 투표 전 1회만 수행 → 체인코드 실행과 별개
 *   4. 인증 결과를 req.voter에 주입 → 이후 라우터는 그대로 재사용
 * ═══════════════════════════════════════════════════════════════
 *
 * Idemix 연동 구현 참조:
 *   - Fabric CA Idemix 등록: `fabric-ca-client enroll --enrollment.type idemix`
 *   - ZKP 검증 라이브러리: @hyperledger/fabric-gateway (Idemix identity 지원)
 *   - 속성 증명: voterEligible=true 속성만 증명, 신원은 미노출
 */

'use strict';

/**
 * 유권자 자격을 검증합니다.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{eligible: boolean, anonymous: boolean, mspId: string}>}
 *
 * ── IDEMIX 연동 시 이 함수 내부를 교체하세요 ──────────────────────
 *
 * // 1. 요청 헤더에서 Idemix 자격증명 추출
 * const credential = req.headers['x-idemix-credential'];
 * if (!credential) return { eligible: false };
 *
 * // 2. Fabric CA에 ZKP 검증 요청
 * //    - "이 유권자는 선거인 명부에 등록됐다"만 증명 (신원 미공개)
 * //    - Idemix 속성: { voterEligible: true, electionID: "..." }
 * const verified = await fabricCA.verifyIdemixCredential(credential, {
 *   attributeName: 'voterEligible',
 *   attributeValue: '1',
 * });
 * return { eligible: verified, anonymous: true, mspId: 'ElectionCommissionMSP' };
 *
 * ── 현재 구현 (Idemix 없는 개발용) ────────────────────────────────
 */
async function verifyVoterEligibility(req) {
  // TODO: Idemix 연동 시 이 블록을 교체
  // 현재는 모든 요청을 적격 유권자로 취급
  return {
    eligible:  true,
    anonymous: true,              // Idemix ZKP: 신원 미노출
    mspId:     'ElectionCommissionMSP',
  };
}

/**
 * Express 미들웨어 — 투표 API 앞에 적용
 *
 * 사용법 (routes/vote.js):
 *   const { requireVoterAuth } = require('../middleware/auth');
 *   router.post('/', requireVoterAuth, async (req, res) => { ... });
 *
 * Idemix 연동 후에도 라우터 코드는 변경 불필요.
 * req.voter.eligible / req.voter.mspId 를 그대로 사용하면 됩니다.
 */
async function requireVoterAuth(req, res, next) {
  try {
    const voter = await verifyVoterEligibility(req);
    if (!voter.eligible) {
      return res.status(403).json({
        error: '투표 자격이 없습니다. (Idemix 자격증명 필요)',
        // Idemix 연동 후: Fabric CA 등록 방법 안내 추가
      });
    }
    req.voter = voter;  // 이후 라우터에서 req.voter.mspId 등으로 접근
    next();
  } catch (err) {
    res.status(500).json({ error: `인증 처리 오류: ${err.message}` });
  }
}

/**
 * Idemix 연동 준비 상태 확인 (헬스 체크용)
 *
 * Idemix 연동 후 Fabric CA 연결 상태를 반환하도록 수정하세요.
 */
function idemixStatus() {
  return {
    enabled: false,           // Idemix 연동 후 true로 변경
    mode:    'bypass',        // 'bypass' | 'idemix'
    note:    'Idemix ZKP 미연동 상태 — verifyVoterEligibility() 함수 교체 필요',
  };
}

module.exports = { requireVoterAuth, idemixStatus };
