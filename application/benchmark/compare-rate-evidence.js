#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { summarize } = require('./summarize-rate');
const { writeJsonEvidenceExclusive } = require('./evidence-contract');

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function percentChange(before, after) {
  if (!Number.isFinite(before) || before === 0 || !Number.isFinite(after)) {
    throw new Error('comparison values must be finite and baseline must be non-zero');
  }
  return +(((after - before) / before) * 100).toFixed(6);
}

function requireComparableConfiguration(before, after) {
  const fields = ['rates', 'durationSec', 'repeats', 'maxInFlight', 'voterOperation',
    'fabricTransactionsPerSuccessfulVoterOperation'];
  if (!before || !after || fields.some(field => !sameJson(before[field], after[field])) ||
      before.repeats < 2 || before.credentialMode?.enabled !== after.credentialMode?.enabled ||
      before.credentialMode?.impl !== after.credentialMode?.impl) {
    throw new Error('fixed-rate reports do not have comparable workload configurations');
  }
  if (after.preparedVisibilityRetryTelemetry !== true) {
    throw new Error('post-fix report does not declare retry telemetry');
  }
}

function compareReports(baselineReport, postFixReport) {
  if (baselineReport?.schemaVersion !== 2 || postFixReport?.schemaVersion !== 3) {
    throw new Error('comparison requires a schema v2 baseline and schema v3 post-fix report');
  }
  requireComparableConfiguration(baselineReport.config, postFixReport.config);
  const baseline = summarize(baselineReport);
  const postFix = summarize(postFixReport);
  const postByRate = new Map(postFix.byOfferedRate.map(value => [value.offeredRate, value]));
  const rates = baseline.byOfferedRate.map(before => {
    const after = postByRate.get(before.offeredRate);
    if (!after) throw new Error(`post-fix summary is missing offered rate ${before.offeredRate}`);
    const beforeOps = before.committedVoterOperationsPerSec.mean;
    const afterOps = after.committedVoterOperationsPerSec.mean;
    const beforeFabric = before.committedFabricTransactionsPerSec.mean;
    const afterFabric = after.committedFabricTransactionsPerSec.mean;
    return {
      offeredRate: before.offeredRate,
      committedVoterOperationsPerSec: {
        baseline: before.committedVoterOperationsPerSec,
        postFix: after.committedVoterOperationsPerSec,
        percentChange: percentChange(beforeOps, afterOps),
      },
      committedFabricTransactionsPerSec: {
        baseline: before.committedFabricTransactionsPerSec,
        postFix: after.committedFabricTransactionsPerSec,
        percentChange: percentChange(beforeFabric, afterFabric),
      },
      latencyMs: { baseline: before.logicalLatencyMs, postFix: after.logicalLatencyMs },
      prepareCommitLatencyMs: { baseline: before.prepareCommitLatencyMs, postFix: after.prepareCommitLatencyMs },
      castCommitLatencyMs: { baseline: before.castCommitLatencyMs, postFix: after.castCommitLatencyMs },
      schedulerLagMs: { baseline: before.schedulerLagMs, postFix: after.schedulerLagMs },
      postFixPreparedVisibilityRetry: after.preparedVisibilityRetry,
    };
  });
  if (postByRate.size !== rates.length) throw new Error('post-fix summary has unexpected offered rates');
  return {
    schema: 'mongbas-fixed-rate-before-after/v1',
    createdAt: new Date().toISOString(),
    baseline: { schemaVersion: 2, createdAt: baselineReport.createdAt, config: baselineReport.config, totals: baseline.totals },
    postFix: { schemaVersion: 3, createdAt: postFixReport.createdAt, config: postFixReport.config, totals: postFix.totals },
    rates,
    interpretationBoundary: [
      'Percent changes are descriptive and are not statistical significance tests.',
      'The accumulated ledger and execution time differ, so changes cannot be attributed only to retry logic.',
      'Retry counts were unavailable in the schema v2 baseline.',
    ],
  };
}

if (require.main === module) {
  const [baselinePath, postFixPath, outputPath] = process.argv.slice(2);
  if (!baselinePath || !postFixPath || !outputPath) {
    console.error('usage: compare-rate-evidence.js BASELINE_REPORT.json POST_FIX_REPORT.json OUTPUT.json');
    process.exit(2);
  }
  try {
    const result = compareReports(
      JSON.parse(fs.readFileSync(baselinePath, 'utf8')),
      JSON.parse(fs.readFileSync(postFixPath, 'utf8')),
    );
    writeJsonEvidenceExclusive(outputPath, result);
    console.log(JSON.stringify({ rates: result.rates.length, baseline: result.baseline.totals, postFix: result.postFix.totals }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { compareReports, percentChange, requireComparableConfiguration };
