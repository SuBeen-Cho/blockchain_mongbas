'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../../deploy/linux/post-fix-tps-evaluation.sh'),
  'utf8',
);

test('post-fix TPS evaluation is repeated, isolated, monitored, and non-destructive', () => {
  assert.match(source, /MONGBAS_TPS_RATES:-1,5,10,25,50/);
  assert.match(source, /TPS rates must be comma-separated positive integers/);
  assert.match(source, /each TPS rate must be 1\.\.200/);
  assert.match(source, /MONGBAS_TPS_REPEATS:-5/);
  assert.match(source, /another state-growth, rate, or verifier workload is active/);
  assert.match(source, /MONGBAS_TPS_MIN_FREE_BYTES:-60000000000/);
  assert.match(source, /oom_kill/);
  assert.match(source, /fabric-health-unavailable/);
  assert.match(source, /setsid env/);
  assert.match(source, /sha256-inventory\.txt/);
  assert.match(source, /volumes-before\.txt/);
  assert.doesNotMatch(source, /docker (?:compose )?down|docker volume rm|network\.sh (?:down|clean)/);
});

test('post-fix TPS evaluation retains strict rate summarization and exact accounting', () => {
  const rate = fs.readFileSync(path.join(__dirname, '../../deploy/linux/rate-evaluation.sh'), 'utf8');
  const summary = fs.readFileSync(path.join(__dirname, '../benchmark/summarize-rate.js'), 'utf8');
  const benchmark = fs.readFileSync(path.join(__dirname, '../benchmark/elgamal-rate-bench.js'), 'utf8');
  const voteRoute = fs.readFileSync(path.join(__dirname, '../src/routes/vote.js'), 'utf8');
  assert.match(rate, /summarize-rate\.js/);
  assert.match(rate, /REQUIRE_DEMO_ADMISSION=false/);
  assert.match(rate, /ENABLE_BENCH_ENDPOINTS=true/);
  assert.match(summary, /round\.failed !== 0/);
  assert.match(summary, /transactionsPerCommittedVoterOperation !== 2/);
  assert.match(summary, /two-sided Student-t over repetition means/);
  assert.match(benchmark, /preparedVisibilityEndorsementRetries/);
  assert.match(summary, /preparedVisibilityVoterOperationsRetried/);
  assert.match(voteRoute, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(voteRoute, /benchmarkRetryTelemetryEnabled \? \{ benchmark:/);
});
