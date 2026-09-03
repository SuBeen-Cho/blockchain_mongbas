'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { percentile } = require('../benchmark/qr-admission-live-load');

test('QR admission load percentile uses nearest-rank without mutating samples', () => {
  const samples = [40, 10, 30, 20];
  assert.equal(percentile(samples, 0.5), 20);
  assert.equal(percentile(samples, 0.95), 40);
  assert.deepEqual(samples, [40, 10, 30, 20]);
  assert.throws(() => percentile([], 0.5), /non-empty/);
  assert.throws(() => percentile([1, -1], 0.5), /non-negative/);
});
