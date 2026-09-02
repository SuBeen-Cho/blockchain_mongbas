'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('runtime metadata and UI do not self-certify coercion resistance', () => {
  const chaincode = read('chaincode/voting/voting.go');
  const verifyPage = read('frontend/src/pages/VerifyPage.jsx');
  const voterPage = read('frontend/src/pages/VoterPage.jsx');
  const controlPage = read('frontend/src/pages/ControlPage.jsx');
  const trackPage = read('frontend/src/pages/TrackPage.jsx');
  const receiptFree = read('frontend/src/components/verify-animations/ReceiptFreeDiagram.jsx');
  const diagram = read('frontend/src/components/verify-animations/DeniableDiagram.jsx');
  const e2e = read('application/scripts/full-election-e2e.js');

  assert.doesNotMatch(chaincode, /Status:\s+"achieved"/);
  assert.doesNotMatch(chaincode, /Cleansing-Hiding coercion resistance/);
  assert.match(chaincode, /Property:\s+"Coercion Resistance"[\s\S]{0,120}Status:\s+"unverified"/);
  assert.doesNotMatch(verifyPage, /강압자가 어느 것이 진짜인지 구분할 수 없/);
  assert.doesNotMatch(verifyPage, /공개된 암호화 키로 모든 투표를 복호화|receipt 생성이 원천 불가/);
  assert.doesNotMatch(voterPage, /Idemix 익명 자격 증명을 발급|100% 동일/);
  assert.doesNotMatch(controlPage, /100% 동일|강압자 구별 불가/);
  assert.doesNotMatch(trackPage, /시스템이 절대 복호화하지 않/);
  assert.doesNotMatch(receiptFree, /receipt 생성이 원천 불가|강압자에게 누구를 찍었는지 증명할 수 없/);
  assert.doesNotMatch(diagram, /Coercion Resistance —/);
  assert.doesNotMatch(diagram, /강압자가 구분 불가/);
  assert.doesNotMatch(e2e, /Coercion Resistance E2E Test/);
});

test('public showcase and credential labels do not claim unverified equivalence', () => {
  const showcase = read('frontend/public/showcase3.html');
  const auth = read('application/src/middleware/auth.js');
  const psPrototype = read('application/src/lib/ps-idemix.js');

  assert.doesNotMatch(showcase, /7\/7 보안 속성/);
  assert.doesNotMatch(showcase, /7<b>\/7<\/b>|7\/7[^\n]{0,80}전부 충족|학술 보안속성 전부 충족/);
  assert.doesNotMatch(showcase, /하나도 빠짐없이 달성한 첫 사례/);
  assert.doesNotMatch(showcase, /완벽한 비밀|모두 충족|100% 전부 달성|강압자가 눈치챌 수 없|프라이버시는 거의 공짜/);
  assert.match(showcase, /현재 7\/7 완전 검증을 주장하지 않습니다/);
  assert.match(showcase, /강압저항성은 현재 unverified/);
  assert.doesNotMatch(auth, /진짜 Idemix|Fabric Idemix와 동일/);
  assert.match(auth, /PS-BN254 credential prototype/);
  assert.match(psPrototype, /Fabric Idemix와의 wire-format/);
});

test('legacy security scenario does not mislabel missing-election rejection as endorsement evidence', () => {
  const scenarios = read('scripts/security-scenarios-extended.js');

  assert.doesNotMatch(scenarios, /단일 서명 거부율/);
  assert.doesNotMatch(scenarios, /정책 위반 거부 횟수/);
  assert.doesNotMatch(scenarios, /코드 레벨 추가 검증 없이도 정책이 보장/);
  assert.match(scenarios, /cannot measure or prove an endorsement-policy rejection/);
  assert.match(scenarios, /2-of-3 endorsement 차단 증거가 아닙니다/);
});
