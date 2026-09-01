'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, repetitionSummary } = require('../benchmark/summarize-rate');

function validReport() {
  return {
    schemaVersion: 2,
    scenario: 'vector-v3-fixed-offered-rate',
    rounds: [{
      offeredRate: 5,
      repetition: 1,
      attempted: 2,
      committed: 2,
      failed: 0,
      transactionAccounting: {
        transactionsPerCommittedVoterOperation: 2,
        fabricTransactionsAttempted: 4,
        fabricTransactionsCommitted: 4,
        measuredSubmissionSec: 1,
        committedVoterOperationsPerSec: 2,
        committedFabricTransactionsPerSec: 4,
      },
      latencyMs: { n: 2, avg: 10, stddev: 1, p50: 9, p95: 11, p99: 11, max: 11 },
      prepareCommitLatencyMs: { n: 2, avg: 5, stddev: 0.5, p50: 5, p95: 6, p99: 6, max: 6 },
      castCommitLatencyMs: { n: 2, avg: 5, stddev: 1, p50: 4, p95: 6, p99: 6, max: 6 },
      schedulerLagMs: { n: 2, avg: 1, p50: 1, p95: 1, p99: 1, max: 1 },
      maxInFlight: 1,
      tallies: [{ success: true }],
    }],
  };
}

test('strict rate summary accepts exact zero-failure evidence', () => {
  const result = summarize(validReport());
  assert.deepEqual(result.totals, { rounds: 1, attempted: 2, committed: 2, failed: 0,
    fabricTransactionsAttempted: 4, fabricTransactionsCommitted: 4, elections: 1 });
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

test('strict rate summary rejects single-transaction accounting for prepare plus cast', () => {
  const report = validReport();
  report.rounds[0].transactionAccounting.fabricTransactionsCommitted = 2;
  assert.throws(() => summarize(report), /two-transaction voter-operation accounting/);
});

test('repetition summary reports sample deviation and Student-t 95% interval', () => {
  const result = repetitionSummary([1, 2, 3, 4, 5]);
  assert.equal(result.n, 5);
  assert.equal(result.mean, 3);
  assert.equal(result.median, 3);
  assert.equal(result.stddev, 1.581139);
  assert.deepEqual(result.confidence95, {
    method: 'two-sided Student-t over repetition means',
    low: 1.037072,
    high: 4.962928,
  });
});
