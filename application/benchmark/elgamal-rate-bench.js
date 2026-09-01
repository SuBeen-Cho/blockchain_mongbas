#!/usr/bin/env node
/**
 * Fixed offered-rate benchmark for the authoritative vector-v3 HTTP→Fabric
 * path. Unlike the historical Caliper CastVote workload, every measured vote
 * carries a real vector ballot proof and a credential-bound nullifier.
 *
 * Credentials and proofs are prepared before each measured batch. A batch is
 * capped at 1,000 unique demo voters; longer rounds use multiple elections and
 * exclude setup time from the offered-rate/latency statistics.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  CANDIDATES,
  get,
  createElection,
  issueCredential,
  prepareVote,
  castPreparedVote,
  measureExactTally,
  stats,
  systemSnapshot,
} = require('./elgamal-concurrency-bench');

const args = {};
process.argv.slice(2).forEach((arg, index, all) => {
  if (arg.startsWith('--')) args[arg.slice(2)] = all[index + 1] ?? true;
});

const RATES = String(args.rates || '1,5,10,25,50').split(',').map(Number);
const DURATION_SEC = Number(args.duration || 60);
const REPEATS = Number(args.repeats || 1);
const MAX_IN_FLIGHT = Number(args.maxInFlight || 250);
const MAX_VOTERS = 1000;
const OUT = args.out || path.join(__dirname, `../benchmark-reports/elgamal-rate-${new Date().toISOString().replace(/[:.]/g, '')}.json`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateConfig() {
  if (!process.env.ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN is required');
  if (!Number.isFinite(DURATION_SEC) || DURATION_SEC <= 0 || DURATION_SEC > 3600) throw new Error('duration must be in (0, 3600] seconds');
  if (!Number.isInteger(REPEATS) || REPEATS < 1 || REPEATS > 20) throw new Error('repeats must be an integer from 1 to 20');
  if (!Number.isInteger(MAX_IN_FLIGHT) || MAX_IN_FLIGHT < 1 || MAX_IN_FLIGHT > 1000) throw new Error('maxInFlight must be an integer from 1 to 1000');
  if (!RATES.length || RATES.some(rate => !Number.isFinite(rate) || rate <= 0 || rate > 200)) throw new Error('rates must be numbers in (0, 200]');
}

async function prepareBatch(label, count) {
  const election = await createElection(label);
  const credentials = [];
  for (let index = 0; index < count; index += 1) {
    credentials.push(await issueCredential(election.electionID, index + 1));
  }
  return {
    ...election,
    prepared: credentials.map((credential, index) =>
      prepareVote(election.electionID, election.pubKey, election.blindingFactor, index, credential)),
  };
}

async function submitAtFixedRate(batch, rate) {
  const intervalNs = BigInt(Math.round(1e9 / rate));
  const origin = process.hrtime.bigint() + 100_000_000n;
  const active = new Set();
  const results = [];
  let maximumInFlight = 0;

  for (let index = 0; index < batch.prepared.length; index += 1) {
    const due = origin + BigInt(index) * intervalNs;
    const remainingMs = Number(due - process.hrtime.bigint()) / 1e6;
    if (remainingMs > 1) await sleep(remainingMs);

    while (active.size >= MAX_IN_FLIGHT) await Promise.race(active);
    const scheduledNs = due;
    let promise;
    promise = castPreparedVote(batch.prepared[index], index)
      .then(result => {
        result.scheduleLagMs = Number(process.hrtime.bigint() - scheduledNs) / 1e6 - result.ms;
        results.push(result);
      })
      .finally(() => active.delete(promise));
    active.add(promise);
    maximumInFlight = Math.max(maximumInFlight, active.size);
  }
  await Promise.all(active);
  const finished = process.hrtime.bigint();
  return { results, maximumInFlight, origin, elapsedMs: Number(finished - origin) / 1e6 };
}

async function runRate(rate, repetition) {
  const total = Math.max(1, Math.round(rate * DURATION_SEC));
  const batchSizes = [];
  for (let remaining = total; remaining > 0; remaining -= MAX_VOTERS) batchSizes.push(Math.min(MAX_VOTERS, remaining));
  const all = [];
  const tallies = [];
  const snapshots = [];
  let measuredSubmissionMs = 0;
  let maxInFlight = 0;

  for (let batchIndex = 0; batchIndex < batchSizes.length; batchIndex += 1) {
    const count = batchSizes[batchIndex];
    console.log(`[rate=${rate} rep=${repetition}] preparing batch ${batchIndex + 1}/${batchSizes.length} (${count} voters)`);
    const batch = await prepareBatch(`rate-${rate}-rep-${repetition}-batch-${batchIndex + 1}`, count);
    snapshots.push({ phase: 'before', batch: batchIndex + 1, value: systemSnapshot() });
    const submitted = await submitAtFixedRate(batch, rate);
    measuredSubmissionMs += submitted.elapsedMs;
    maxInFlight = Math.max(maxInFlight, submitted.maximumInFlight);
    all.push(...submitted.results);
    snapshots.push({ phase: 'after', batch: batchIndex + 1, value: systemSnapshot() });

    const expected = Object.fromEntries(CANDIDATES.map(candidate => [candidate, 0]));
    for (const result of submitted.results.filter(item => item.ok)) {
      expected[CANDIDATES[result.index % CANDIDATES.length]] += 1;
    }
    const tally = await measureExactTally(batch.electionID, expected);
    tallies.push({ electionID: batch.electionID, ...tally });
    if (!tally.success) throw new Error(`strict tally failed at rate=${rate}, repetition=${repetition}, batch=${batchIndex + 1}: ${tally.error}`);
  }

  const successes = all.filter(item => item.ok);
  const failures = all.filter(item => !item.ok);
  const errors = {};
  for (const failure of failures) {
    const key = `${failure.status}:${String(failure.error || '').slice(0, 160)}`;
    errors[key] = (errors[key] || 0) + 1;
  }
  const fabricTransactionsAttempted = all.reduce((sum, item) => sum + 1 + Number(item.castAttempted === true), 0);
  const fabricTransactionsCommitted = all.reduce((sum, item) =>
    sum + Number(item.prepareCommitted === true) + Number(item.castCommitted === true), 0);
  const measuredSubmissionSec = measuredSubmissionMs / 1000;
  return {
    offeredRate: rate,
    repetition,
    plannedDurationSec: DURATION_SEC,
    attempted: all.length,
    committed: successes.length,
    failed: failures.length,
    failureRate: +(100 * failures.length / all.length).toFixed(4),
    transactionAccounting: {
      transactionsPerCommittedVoterOperation: 2,
      fabricTransactionsAttempted,
      fabricTransactionsCommitted,
      measuredSubmissionSec: +measuredSubmissionSec.toFixed(6),
      committedVoterOperationsPerSec: +(successes.length / measuredSubmissionSec).toFixed(6),
      committedFabricTransactionsPerSec: +(fabricTransactionsCommitted / measuredSubmissionSec).toFixed(6),
    },
    latencyMs: stats(successes.map(item => item.ms)),
    prepareCommitLatencyMs: stats(successes.map(item => item.prepareMs)),
    castCommitLatencyMs: stats(successes.map(item => item.castMs)),
    schedulerLagMs: stats(all.map(item => Math.max(0, item.scheduleLagMs))),
    maxInFlight,
    errors,
    tallies,
    snapshots,
  };
}

async function main() {
  validateConfig();
  const health = await get('/health');
  if (health.status !== 200 || health.body?.benchmark?.rateLimitsDisabled !== true) {
    throw new Error('an isolated healthy backend with DISABLE_RATE_LIMITS=true is required');
  }
  if (!health.body?.idemix?.enabled) throw new Error('credential verification must be enabled; bypass results are not authoritative');

  const rounds = [];
  for (const rate of RATES) {
    for (let repetition = 1; repetition <= REPEATS; repetition += 1) {
      rounds.push(await runRate(rate, repetition));
    }
  }
  const output = {
    schemaVersion: 2,
    scenario: 'vector-v3-fixed-offered-rate',
    createdAt: new Date().toISOString(),
    config: { rates: RATES, durationSec: DURATION_SEC, repeats: REPEATS, maxInFlight: MAX_IN_FLIGHT,
      credentialMode: health.body.idemix, setupExcluded: true, voterOperation: 'prepare-vector commit + cast-vector commit',
      fabricTransactionsPerSuccessfulVoterOperation: 2 },
    rounds,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(`fixed-rate evidence written: ${OUT}`);
  if (rounds.some(round => round.failed > 0 || round.tallies.some(tally => !tally.success))) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}

module.exports = { submitAtFixedRate, runRate };
