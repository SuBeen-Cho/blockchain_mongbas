'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('demo seed uses admission-bound vector-v3 prepare and cast paths', () => {
  const file = fs.readFileSync(path.join(__dirname, '../src/routes/elections.js'), 'utf8');
  const source = file.slice(file.indexOf("router.post('/:id/seed-votes'"), file.indexOf("router.post('/:id/close'"));
  assert.match(source, /\['elgamal', 'elgamal-vector-v3'\]/);
  assert.match(source, /credential\/demo-admission\/redeem/);
  assert.match(source, /vote\/prepare-vector/);
  assert.match(source, /vote\/cast-vector/);
  assert.doesNotMatch(source, /credential\/idemix.*seed-votes/s);
});
