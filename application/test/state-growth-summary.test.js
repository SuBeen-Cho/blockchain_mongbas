'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSnapshot, summarize } = require('../benchmark/summarize-state-growth');

test('state growth summary computes per-target and aggregate deltas', () => {
  const value = summarize('peer\tledger\t100\ndb\tcouchdb\t200\n', 'peer\tledger\t140\ndb\tcouchdb\t260\n', 10);
  assert.equal(value.totalDeltaKiB, 100);
  assert.equal(value.aggregateBytesPerBallot, 10240);
  assert.deepEqual(value.targets.map(row => row.deltaKiB), [40, 60]);
});

test('state growth summary fails closed on malformed, changed or non-growing snapshots', () => {
  assert.throws(() => parseSnapshot('peer\tledger\tnan\n'));
  assert.throws(() => summarize('peer\tledger\t100\n', 'other\tledger\t120\n', 1));
  assert.throws(() => summarize('peer\tledger\t100\n', 'peer\tledger\t100\n', 1));
});
