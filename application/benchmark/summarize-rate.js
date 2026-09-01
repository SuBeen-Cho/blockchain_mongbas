#!/usr/bin/env node
'use strict';

const fs = require('fs');

function summarize(report) {
  if (!report || report.schemaVersion !== 1 || report.scenario !== 'vector-v3-fixed-offered-rate') {
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
    for (const field of ['n', 'avg', 'p50', 'p95', 'p99', 'max']) {
      if (!Number.isFinite(round.latencyMs?.[field])) throw new Error(`round ${index}: invalid latency ${field}`);
    }
    if (round.latencyMs.n !== round.committed) throw new Error(`round ${index}: latency sample count mismatch`);
    return {
      offeredRate: round.offeredRate,
      repetition: round.repetition,
      attempted: round.attempted,
      committed: round.committed,
      failed: round.failed,
      latencyMs: round.latencyMs,
      schedulerLagMs: round.schedulerLagMs,
      maxInFlight: round.maxInFlight,
      electionCount: round.tallies.length,
    };
  });
  return {
    schemaVersion: 1,
    sourceScenario: report.scenario,
    createdAt: new Date().toISOString(),
    strict: true,
    totals: {
      rounds: rounds.length,
      attempted: rounds.reduce((sum, round) => sum + round.attempted, 0),
      committed: rounds.reduce((sum, round) => sum + round.committed, 0),
      failed: rounds.reduce((sum, round) => sum + round.failed, 0),
      elections: rounds.reduce((sum, round) => sum + round.electionCount, 0),
    },
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

module.exports = { summarize };
