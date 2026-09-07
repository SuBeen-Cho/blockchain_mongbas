import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('standalone tracking reports a mutated receipt as an expected detection', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../src/pages/TrackPage.jsx'), 'utf8');
  assert.match(source, /async function track\(rawCode, tampered = false\)/);
  assert.match(source, /track\(hex\.slice\(0, -1\) \+ flipped, true\)/);
  assert.match(source, /변조 탐지 성공/);
});
