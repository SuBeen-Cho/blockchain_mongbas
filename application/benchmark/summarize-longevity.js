#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonEvidenceExclusive } = require('./evidence-contract');

const [roundDirectory, outputFile, metadataFile] = process.argv.slice(2);
if (!roundDirectory || !outputFile || !metadataFile) {
  throw new Error('usage: summarize-longevity.js <round-dir> <output.json> <metadata.json>');
}

const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
const files = fs.readdirSync(roundDirectory).filter(name => /^round-[0-9]+\.json$/.test(name)).sort();
if (files.length === 0) throw new Error('no longevity round reports found');

const rounds = files.map((name) => {
  const report = JSON.parse(fs.readFileSync(path.join(roundDirectory, name), 'utf8'));
  if (!Array.isArray(report.rounds) || report.rounds.length !== 1) {
    throw new Error(`${name}: expected exactly one concurrency round`);
  }
  const round = report.rounds[0];
  const expected = round.tally?.expectedResults || {};
  const actual = round.tally?.actualResults || {};
  const exact = JSON.stringify(expected) === JSON.stringify(actual);
  const strictSuccess = round.fail === 0 && round.success === round.concurrency &&
    round.tally?.success === true && round.tally?.totalVotes === round.concurrency && exact &&
    round.tally?.vectorPartialDecryptionProofs >= 2;
  return {
    file: name,
    electionID: round.electionID,
    concurrency: round.concurrency,
    success: round.success,
    fail: round.fail,
    failRate: round.failRate,
    tps: round.tps,
    elapsedSec: round.elapsedSec,
    latency: round.latency,
    tally: round.tally,
    strictSuccess,
  };
});

const numbers = (field) => rounds.map(round => round[field]);
const mean = values => +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3);
const result = {
  schemaVersion: 1,
  kind: metadata.kind,
  startedAt: metadata.startedAt,
  finishedAt: metadata.finishedAt,
  targetDurationSeconds: metadata.targetDurationSeconds,
  actualDurationSeconds: metadata.actualDurationSeconds,
  concurrency: metadata.concurrency,
  publicCommit: metadata.publicCommit,
  roundCount: rounds.length,
  submittedVotes: rounds.reduce((sum, round) => sum + round.concurrency, 0),
  committedVotes: rounds.reduce((sum, round) => sum + round.success, 0),
  failedVotes: rounds.reduce((sum, round) => sum + round.fail, 0),
  strictRoundPasses: rounds.filter(round => round.strictSuccess).length,
  exactTallies: rounds.filter(round => round.tally?.success === true).length,
  tps: { mean: mean(numbers('tps')), min: Math.min(...numbers('tps')), max: Math.max(...numbers('tps')) },
  rounds,
};
result.success = result.actualDurationSeconds >= result.targetDurationSeconds &&
  result.failedVotes === 0 && result.strictRoundPasses === result.roundCount;

writeJsonEvidenceExclusive(outputFile, result);
if (!result.success) {
  throw new Error(`longevity validation failed: duration=${result.actualDurationSeconds}/${result.targetDurationSeconds}, failedVotes=${result.failedVotes}, strictPasses=${result.strictRoundPasses}/${result.roundCount}`);
}
process.stdout.write(`${JSON.stringify({ success: true, kind: result.kind, rounds: result.roundCount,
  committedVotes: result.committedVotes, durationSeconds: result.actualDurationSeconds, meanTps: result.tps.mean })}\n`);
