#!/usr/bin/env node
'use strict';

const fs = require('fs');

const T95 = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
  2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
  2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045];

function repetitionSummary(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some(value => !Number.isFinite(value))) {
    throw new Error('at least two finite repetitions are required for a confidence interval');
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const sampleVariance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(sampleVariance);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const critical = n - 1 < T95.length ? T95[n - 1] : 1.96;
  const margin = critical * stddev / Math.sqrt(n);
  return { n, mean: +mean.toFixed(6), median: +median.toFixed(6), stddev: +stddev.toFixed(6),
    confidence95: { method: 'two-sided Student-t over repetition means', low: +(mean - margin).toFixed(6), high: +(mean + margin).toFixed(6) } };
}

function summarize(report) {
  if (!report || report.schemaVersion !== 2 || report.scenario !== 'vector-v3-fixed-offered-rate') {
    throw new Error('unsupported fixed-rate report schema');
  }
  if (!Array.isArray(report.rounds) || report.rounds.length === 0) throw new Error('fixed-rate report has no rounds');
  const rounds = report.rounds.map((round, index) => {
    if (!Number.isFinite(round.offeredRate) || round.offeredRate <= 0) throw new Error(`round ${index}: invalid offered rate`);
    if (!Number.isInteger(round.attempted) || round.attempted < 1) throw new Error(`round ${index}: invalid attempted count`);
    if (round.committed + round.failed !== round.attempted) throw new Error(`round ${index}: count mismatch`);
    if (round.failed !== 0) throw new Error(`round ${index}: ${round.failed} failed transactions`);
    if (!Array.isArray(round.tallies) || round.tallies.length === 0 || round.tallies.some(tally => tally.success !== true)) {
      throw new Error(`round ${index}: strict threshold tally evidence missing or failed`);
    }
    for (const field of ['n', 'avg', 'stddev', 'p50', 'p95', 'p99', 'max']) {
      if (!Number.isFinite(round.latencyMs?.[field])) throw new Error(`round ${index}: invalid latency ${field}`);
    }
    if (round.latencyMs.n !== round.committed) throw new Error(`round ${index}: latency sample count mismatch`);
    const accounting = round.transactionAccounting;
    if (accounting?.transactionsPerCommittedVoterOperation !== 2 ||
        accounting?.fabricTransactionsAttempted !== round.attempted * 2 ||
        accounting?.fabricTransactionsCommitted !== round.committed * 2 ||
        !Number.isFinite(accounting?.measuredSubmissionSec) || accounting.measuredSubmissionSec <= 0 ||
        !Number.isFinite(accounting?.committedVoterOperationsPerSec) ||
        !Number.isFinite(accounting?.committedFabricTransactionsPerSec)) {
      throw new Error(`round ${index}: invalid two-transaction voter-operation accounting`);
    }
    for (const metric of ['prepareCommitLatencyMs', 'castCommitLatencyMs']) {
      for (const field of ['n', 'avg', 'stddev', 'p50', 'p95', 'p99', 'max']) {
        if (!Number.isFinite(round[metric]?.[field])) throw new Error(`round ${index}: invalid ${metric} ${field}`);
      }
      if (round[metric].n !== round.committed) throw new Error(`round ${index}: ${metric} sample count mismatch`);
    }
    return {
      offeredRate: round.offeredRate,
      repetition: round.repetition,
      attempted: round.attempted,
      committed: round.committed,
      failed: round.failed,
      transactionAccounting: accounting,
      latencyMs: round.latencyMs,
      prepareCommitLatencyMs: round.prepareCommitLatencyMs,
      castCommitLatencyMs: round.castCommitLatencyMs,
      schedulerLagMs: round.schedulerLagMs,
      maxInFlight: round.maxInFlight,
      electionCount: round.tallies.length,
    };
  });
  const grouped = new Map();
  for (const round of rounds) {
    const values = grouped.get(round.offeredRate) || [];
    values.push(round);
    grouped.set(round.offeredRate, values);
  }
  const byOfferedRate = [...grouped.entries()].map(([offeredRate, values]) => ({
    offeredRate,
    repetitions: values.length,
    committedVoterOperationsPerSec: values.length >= 2 ? repetitionSummary(values.map(value => value.transactionAccounting.committedVoterOperationsPerSec)) : null,
    committedFabricTransactionsPerSec: values.length >= 2 ? repetitionSummary(values.map(value => value.transactionAccounting.committedFabricTransactionsPerSec)) : null,
    logicalLatencyAverageMs: values.length >= 2 ? repetitionSummary(values.map(value => value.latencyMs.avg)) : null,
  })).sort((left, right) => left.offeredRate - right.offeredRate);
  return {
    schemaVersion: 2,
    sourceScenario: report.scenario,
    createdAt: new Date().toISOString(),
    strict: true,
    totals: {
      rounds: rounds.length,
      attempted: rounds.reduce((sum, round) => sum + round.attempted, 0),
      committed: rounds.reduce((sum, round) => sum + round.committed, 0),
      failed: rounds.reduce((sum, round) => sum + round.failed, 0),
      fabricTransactionsAttempted: rounds.reduce((sum, round) => sum + round.transactionAccounting.fabricTransactionsAttempted, 0),
      fabricTransactionsCommitted: rounds.reduce((sum, round) => sum + round.transactionAccounting.fabricTransactionsCommitted, 0),
      elections: rounds.reduce((sum, round) => sum + round.electionCount, 0),
    },
    byOfferedRate,
    rounds,
  };
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: summarize-rate.js INPUT.json OUTPUT.json');
    process.exit(2);
  }
  try {
    const summary = summarize(JSON.parse(fs.readFileSync(input, 'utf8')));
    fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(summary.totals));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { summarize, repetitionSummary };
