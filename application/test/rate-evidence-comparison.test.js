'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compareReports } = require('../benchmark/compare-rate-evidence');

function round(repetition, throughput, retry = null) {
  return {
    offeredRate: 5, repetition, attempted: 2, committed: 2, failed: 0,
    transactionAccounting: {
      transactionsPerCommittedVoterOperation: 2, fabricTransactionsAttempted: 4,
      fabricTransactionsCommitted: 4, measuredSubmissionSec: 1,
      committedVoterOperationsPerSec: throughput,
      committedFabricTransactionsPerSec: throughput * 2,
    },
    preparedVisibilityRetry: retry,
    latencyMs: { n: 2, avg: 10, stddev: 1, p50: 9, p95: 11, p99: 11, max: 11 },
    prepareCommitLatencyMs: { n: 2, avg: 5, stddev: 1, p50: 5, p95: 6, p99: 6, max: 6 },
    castCommitLatencyMs: { n: 2, avg: 5, stddev: 1, p50: 4, p95: 6, p99: 6, max: 6 },
    schedulerLagMs: { n: 2, avg: 1, stddev: 0, p50: 1, p95: 1, p99: 1, max: 1 },
    maxInFlight: 2,
    tallies: [{ success: true }],
  };
}

function reports() {
  const common = {
    rates: [5], durationSec: 60, repeats: 2, maxInFlight: 250,
    credentialMode: { enabled: true, impl: 'Ed25519-asymmetric' },
    voterOperation: 'prepare-vector commit + cast-vector commit',
    fabricTransactionsPerSuccessfulVoterOperation: 2,
  };
  const retry = { voterOperationsRetried: 1, endorsementRetries: 1,
    requestedDelayMs: 100, maximumRetriesForOneOperation: 1 };
  return {
    baseline: { schemaVersion: 2, scenario: 'vector-v3-fixed-offered-rate', createdAt: '2026-09-01T00:00:00Z',
      config: common, rounds: [round(1, 4), round(2, 4)] },
    postFix: { schemaVersion: 3, scenario: 'vector-v3-fixed-offered-rate', createdAt: '2026-09-02T00:00:00Z',
      config: { ...common, preparedVisibilityRetryTelemetry: true },
      rounds: [round(1, 5, retry), round(2, 5, retry)] },
  };
}

test('comparison preserves evidence and computes descriptive throughput change', () => {
  const { baseline, postFix } = reports();
  const result = compareReports(baseline, postFix);
  assert.equal(result.rates[0].committedVoterOperationsPerSec.percentChange, 25);
  assert.equal(result.rates[0].committedFabricTransactionsPerSec.percentChange, 25);
  assert.equal(result.rates[0].postFixPreparedVisibilityRetry.endorsementRetries, 2);
  assert.match(result.interpretationBoundary.join(' '), /cannot be attributed only to retry logic/);
});

test('comparison rejects mismatched conditions and missing post-fix telemetry', () => {
  const mismatch = reports();
  mismatch.postFix.config.durationSec = 30;
  assert.throws(() => compareReports(mismatch.baseline, mismatch.postFix), /comparable workload/);

  const missing = reports();
  delete missing.postFix.config.preparedVisibilityRetryTelemetry;
  assert.throws(() => compareReports(missing.baseline, missing.postFix), /retry telemetry/);
});
