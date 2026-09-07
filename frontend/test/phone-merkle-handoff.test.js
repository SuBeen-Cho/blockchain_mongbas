import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('phone verification waits for an explicit presenter action after Merkle build', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../src/pages/ControlPage.jsx'), 'utf8');
  assert.match(source, /pendingVerifyRef\.current = code/);
  assert.doesNotMatch(source, /if \(status === 'CLOSED'\) runVerify\(code\)/);
  assert.doesNotMatch(source, /if \(pendingVerifyRef\.current\) await runVerify\(pendingVerifyRef\.current\)/);
  assert.match(source, /\[추적하기\]를 눌러 직접 검증하세요/);
  assert.match(source, /disabled=\{busy \|\| !code\}/);
  assert.match(source, /변조 탐지 성공/);
});
