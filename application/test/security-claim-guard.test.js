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
  const diagram = read('frontend/src/components/verify-animations/DeniableDiagram.jsx');
  const e2e = read('application/scripts/full-election-e2e.js');

  assert.doesNotMatch(chaincode, /Status:\s+"achieved"/);
  assert.doesNotMatch(chaincode, /Cleansing-Hiding coercion resistance/);
  assert.match(chaincode, /Property:\s+"Coercion Resistance"[\s\S]{0,120}Status:\s+"unverified"/);
  assert.doesNotMatch(verifyPage, /강압자가 어느 것이 진짜인지 구분할 수 없/);
  assert.doesNotMatch(diagram, /Coercion Resistance —/);
  assert.doesNotMatch(e2e, /Coercion Resistance E2E Test/);
});

test('public showcase and credential labels do not claim unverified equivalence', () => {
  const showcase = read('frontend/public/showcase3.html');
  const auth = read('application/src/middleware/auth.js');
  const psPrototype = read('application/src/lib/ps-idemix.js');

  assert.doesNotMatch(showcase, /7\/7 보안 속성/);
  assert.doesNotMatch(showcase, /하나도 빠짐없이 달성한 첫 사례/);
  assert.match(showcase, /현재 7\/7 완전 검증을 주장하지 않습니다/);
  assert.doesNotMatch(auth, /진짜 Idemix|Fabric Idemix와 동일/);
  assert.match(auth, /PS-BN254 credential prototype/);
  assert.match(psPrototype, /Fabric Idemix와의 wire-format/);
});
