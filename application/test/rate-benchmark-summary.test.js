'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../benchmark/summarize-rate');

function validReport() {
  return {
    schemaVersion: 1,
    scenario: 'vector-v3-fixed-offered-rate',
    rounds: [{
      offeredRate: 5,
      repetition: 1,
      attempted: 2,
      committed: 2,
      failed: 0,
      latencyMs: { n: 2, avg: 10, p50: 9, p95: 11, p99: 11, max: 11 },
      schedulerLagMs: { n: 2, avg: 1, p50: 1, p95: 1, p99: 1, max: 1 },
      maxInFlight: 1,
      tallies: [{ success: true }],
    }],
  };
}

test('strict rate summary accepts exact zero-failure evidence', () => {
  const result = summarize(validReport());
  assert.deepEqual(result.totals, { rounds: 1, attempted: 2, committed: 2, failed: 0, elections: 1 });
});

test('strict rate summary rejects transaction failure', () => {
  const report = validReport();
  report.rounds[0].committed = 1;
  report.rounds[0].failed = 1;
  report.rounds[0].latencyMs.n = 1;
  assert.throws(() => summarize(report), /failed transactions/);
});

test('strict rate summary rejects missing exact tally evidence', () => {
  const report = validReport();
  report.rounds[0].tallies = [];
  assert.throws(() => summarize(report), /tally evidence/);
});
