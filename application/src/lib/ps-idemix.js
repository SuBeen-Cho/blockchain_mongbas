/**
 * ps-idemix.js — Pointcheval-Sanders (PS) Signatures on BN254
 *
 * Hyperledger Fabric Idemix와 동일한 수학 기반:
 *   - BN254 (BN256) 쌍선형 곡선
 *   - PS 서명 (CL 서명의 현대적 구현)
 *   - ZKP 자격증명 증명
 *
 * 서명 방정식: e(h, X * ∏Yi^mi) == e(σ, g2)
 * 여기서 (h, σ)가 서명, X와 Yi는 공개키
 *
 * [B단계] 이 구현이 B단계(진짜 Idemix)의 암호 연산입니다.
 */

'use strict';

const { bn254 }     = require('@noble/curves/bn254');
const { randomBytes, createHash } = require('crypto');

const g1    = bn254.G1.ProjectivePoint.BASE;
const g2    = bn254.G2.ProjectivePoint.BASE;
const Fp12  = bn254.fields.Fp12;
const Fp    = bn254.fields.Fp;
const Fp2   = bn254.fields.Fp2;
const n     = bn254.G1.CURVE.n;   // 스칼라 필드 소수

// ── G1/G2 직렬화 헬퍼 ──────────────────────────────────────────
// @noble/curves bn254는 toBytes()가 미구현이므로 affine 좌표를 직접 직렬화
function g1ToBuffer(P) {
  const aff = P.toAffine();
  const x = Fp.toBytes(aff.x);
  const y = Fp.toBytes(aff.y);
  return Buffer.concat([x, y]); // 64 bytes
}

function g1FromBuffer(buf) {
  const x = Fp.fromBytes(buf.subarray(0, 32));
  const y = Fp.fromBytes(buf.subarray(32, 64));
  return bn254.G1.ProjectivePoint.fromAffine({ x, y });
}

// 속성 수: voterEligible, electionID, exp
const ATTR_COUNT = 3;

// 발급자 키 싱글톤
let _issuerKeys = null;

/**
 * 무작위 스칼라 생성 (BN254 스칼라 필드 내)
 */
function randScalar() {
  return bn254.G1.normPrivateKeyToScalar(randomBytes(32));
}

/**
 * 메시지를 BN254 스칼라로 해시
 */
function msgToScalar(msg) {
  const h = createHash('sha256').update(String(msg)).digest();
  return bn254.G1.normPrivateKeyToScalar(h);
}

/**
 * mod(a, n) — 음수 지원
 */
function mod(a, p) {
  return ((a % p) + p) % p;
}

/**
 * 발급자 키 쌍 생성 (PS 키)
 * sk = (x, y1, ..., yk)
 * pk = (g1, g2, X = g2^x, Y1 = g2^y1, ..., Yk = g2^yk)
 */
function generateIssuerKeys() {
  if (_issuerKeys) return _issuerKeys;

  const x  = randScalar();
  const ys = Array.from({ length: ATTR_COUNT }, () => randScalar());

  const X   = g2.multiply(x);
  const Ys  = ys.map(y => g2.multiply(y));

  // 직렬화 (벤치마크 재시작 없이 재사용)
  _issuerKeys = {
    sk: { x, ys },
    pk: { X, Ys },
  };
  return _issuerKeys;
}

/**
 * PS 서명 발급
 *
 * 입력: attributes = [voterEligible, electionID, exp]
 * 출력: { h_b64, s_b64, attrs, expMs }
 *
 * 서명: (h = g1^u, σ = h^(x + Σ yi*mi))
 */
function issueCredential(attributes) {
  const { sk } = generateIssuerKeys();
  const { x, ys } = sk;

  // 속성을 스칼라로 변환
  const ms = attributes.map(a => msgToScalar(a));

  // 무작위 기저점 h = g1^u
  const u = randScalar();
  const h = g1.multiply(u);

  // 지수 exp = x + Σ yi * mi  (mod n)
  let exponent = x;
  for (let i = 0; i < ys.length; i++) {
    exponent = mod(exponent + mod(ys[i] * ms[i], n), n);
  }

  const sigma = h.multiply(exponent);

  return {
    type:     'ps',
    h:        g1ToBuffer(h).toString('base64url'),
    s:        g1ToBuffer(sigma).toString('base64url'),
    attrs:    attributes,
    expMs:    Date.now() + 3_600_000,
  };
}

/**
 * PS 서명 검증
 *
 * 검증 방정식: e(h, X * ∏Yi^mi) == e(σ, g2)
 * 2 pairings + k G2 scalar mults
 *
 * 반환: { valid, reason?, latencyMs }
 */
function verifyCredential(credObj) {
  try {
    const { pk } = generateIssuerKeys();
    const { X, Ys } = pk;

    if (!credObj || credObj.type !== 'ps') {
      return { valid: false, reason: 'PS credential 형식 오류' };
    }

    if (Date.now() > credObj.expMs) {
      return { valid: false, reason: '자격증명 만료' };
    }

    const attrs = credObj.attrs;
    if (!Array.isArray(attrs) || attrs.length !== ATTR_COUNT) {
      return { valid: false, reason: '속성 수 불일치' };
    }

    if (attrs[0] !== '1') {
      return { valid: false, reason: '투표 자격 속성 없음' };
    }

    // 역직렬화 (64-byte affine x||y 형식)
    const hBuf    = Buffer.from(credObj.h, 'base64url');
    const sBuf    = Buffer.from(credObj.s, 'base64url');
    const hPoint  = g1FromBuffer(hBuf);
    const sPoint  = g1FromBuffer(sBuf);

    // 속성 스칼라
    const ms = attrs.map(a => msgToScalar(a));

    // 공개키 집계: X + Y1^m1 + Y2^m2 + Y3^m3
    let pkAgg = X;
    for (let i = 0; i < Ys.length; i++) {
      pkAgg = pkAgg.add(Ys[i].multiply(ms[i]));
    }

    // 핵심 연산: 2 pairing 검증
    const pa    = bn254.pairing(hPoint, pkAgg);
    const pb    = bn254.pairing(sPoint, g2);
    const valid = Fp12.eql(pa, pb);

    if (!valid) return { valid: false, reason: 'PS 서명 검증 실패' };

    return {
      valid:      true,
      electionID: attrs[1],
    };
  } catch (e) {
    return { valid: false, reason: `PS 파싱 오류: ${e.message}` };
  }
}

/**
 * 자격증명을 헤더 토큰으로 직렬화
 */
function credToToken(cred) {
  return 'ps.' + Buffer.from(JSON.stringify(cred)).toString('base64url');
}

/**
 * 헤더 토큰에서 자격증명 역직렬화
 */
function tokenToCred(token) {
  if (!token.startsWith('ps.')) return null;
  try {
    return JSON.parse(Buffer.from(token.slice(3), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { issueCredential, verifyCredential, credToToken, tokenToCred, generateIssuerKeys };
