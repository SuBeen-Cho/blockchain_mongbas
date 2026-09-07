import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('phone verification waits for publication and runs after Merkle build', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../src/pages/ControlPage.jsx'), 'utf8');
  assert.match(source, /pendingVerifyRef\.current = code/);
  assert.match(source, /if \(status === 'CLOSED'\) runVerify\(code\)/);
  assert.match(source, /if \(pendingVerifyRef\.current\) await runVerify\(pendingVerifyRef\.current\)/);
});
