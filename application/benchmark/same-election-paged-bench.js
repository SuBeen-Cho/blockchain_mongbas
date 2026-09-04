#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const {
  CANDIDATES, get, createElection, prepareVote, castPreparedVote, measureExactTally, stats, systemSnapshot,
} = require('./elgamal-concurrency-bench');
const { writeJsonEvidenceExclusive } = require('./evidence-contract');
const { issueCredentialAuto } = require('../src/routes/credential');
const { connectGateway } = require('../src/gateway');
const { exportPagedBulletinToDirectory } = require('../src/lib/pagedBulletinSpool');

const args = {};
process.argv.slice(2).forEach((argument, index, all) => {
  if (argument.startsWith('--')) args[argument.slice(2)] = all[index + 1] ?? true;
});
const BALLOTS = Number(args.ballots || 100);
const RATE = Number(args.rate || 5);
const MAX_IN_FLIGHT = Number(args.maxInFlight || 20);
const OUT = args.out;
const SPOOL = args.spool;
const BASE = String(args.url || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function validateConfiguration() {
  if (!Number.isInteger(BALLOTS) || BALLOTS < 100 || BALLOTS > 10_000) throw new Error('ballots must be 100..10000');
  if (!Number.isFinite(RATE) || RATE < 1 || RATE > 50) throw new Error('rate must be 1..50');
  if (!Number.isInteger(MAX_IN_FLIGHT) || MAX_IN_FLIGHT < 1 || MAX_IN_FLIGHT > 100) throw new Error('maxInFlight must be 1..100');
  if (!OUT || !SPOOL || !path.isAbsolute(OUT) || !path.isAbsolute(SPOOL)) throw new Error('--out and --spool must be absolute paths');
  if (ADMIN_API_TOKEN.length < 32) throw new Error('ADMIN_API_TOKEN is required');
  if (!process.env.ED25519_PRIVATE_KEY_DER_B64 || !process.env.ED25519_PUBLIC_KEY_DER_B64) {
    throw new Error('fixed Ed25519 issuer keypair is required');
  }
}

async function adminPost(pathname, body, timeoutMs = 600_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${pathname}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_API_TOKEN}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function submitSameElection(election) {
  const intervalNs = BigInt(Math.round(1e9 / RATE));
  const origin = process.hrtime.bigint() + 100_000_000n;
  const active = new Set();
  const results = [];
  const generationMs = [];
  let maximumInFlight = 0;
  for (let index = 0; index < BALLOTS; index += 1) {
    const due = origin + BigInt(index) * intervalNs;
    const remainingMs = Number(due - process.hrtime.bigint()) / 1e6;
    if (remainingMs > 1) await sleep(remainingMs);
    while (active.size >= MAX_IN_FLIGHT) await Promise.race(active);

    const generatedAt = process.hrtime.bigint();
    const issued = await issueCredentialAuto(`same-election-benchmark:${index}`, election.electionID);
    const prepared = prepareVote(election.electionID, election.pubKey, election.blindingFactor, index,
      { credential: issued.token, nullifierMaterial: issued.nullifierMaterial });
    generationMs.push(Number(process.hrtime.bigint() - generatedAt) / 1e6);

    let promise;
    promise = castPreparedVote(prepared, index).then(result => {
      result.scheduleLagMs = Math.max(0, Number(process.hrtime.bigint() - due) / 1e6 - result.ms);
      results.push(result);
    }).finally(() => active.delete(promise));
    active.add(promise);
    maximumInFlight = Math.max(maximumInFlight, active.size);
  }
  await Promise.all(active);
  return { results: results.sort((a, b) => a.index - b.index), generationMs, maximumInFlight,
    elapsedMs: Number(process.hrtime.bigint() - origin) / 1e6 };
}

async function main() {
  validateConfiguration();
  const health = await get('/health');
  if (health.status !== 200 || health.body?.benchmark?.rateLimitsDisabled !== true ||
      health.body?.idemix?.asymEnabled !== true || health.body?.idemix?.enabled !== true) {
    throw new Error('isolated healthy backend with rate limits disabled and Ed25519 verification is required');
  }
  const before = systemSnapshot();
  const election = await createElection(`same-election-${BALLOTS}`);
  const submitted = await submitSameElection(election);
  const failures = submitted.results.filter(result => !result.ok);
  if (failures.length) throw new Error(`same-election cast failures: ${failures.length}/${BALLOTS}`);

  const expected = Object.fromEntries(CANDIDATES.map(candidate => [candidate, 0]));
  for (let index = 0; index < BALLOTS; index += 1) expected[CANDIDATES[index % CANDIDATES.length]]++;
  const castCheckpointPath = path.join(path.dirname(OUT), 'cast-checkpoint.json');
  writeJsonEvidenceExclusive(castCheckpointPath, {
    schema: 'mongbas-same-election-cast-checkpoint/v1',
    createdAt: new Date().toISOString(),
    electionID: election.electionID,
    config: { ballots: BALLOTS, offeredRate: RATE, maxInFlight: MAX_IN_FLIGHT,
      encryptionMode: 'elgamal-vector-v3', candidates: CANDIDATES.length },
    expectedTally: expected,
    castResults: submitted.results,
    credentialAndProofGenerationMs: submitted.generationMs,
    elapsedMs: submitted.elapsedMs,
    maximumInFlight: submitted.maximumInFlight,
    evidenceBoundary: 'Cast-phase checkpoint only; it does not prove close, tally, publication, export, or final verification.',
  });
  const tally = await measureExactTally(election.electionID, expected, 1_300_000);
  if (!tally.success || tally.totalVotes !== BALLOTS) throw new Error(`same-election exact tally failed: ${tally.error || 'count mismatch'}`);
  const publishStarted = process.hrtime.bigint();
  const publish = await adminPost(`/api/elections/${election.electionID}/publish-audit`, {});
  const publishMs = Number(process.hrtime.bigint() - publishStarted) / 1e6;
  if (publish.status < 200 || publish.status >= 300) throw new Error(`audit publication failed: HTTP ${publish.status}`);

  const { gateway, contract } = await connectGateway();
  let exported;
  const exportStarted = process.hrtime.bigint();
  try {
    exported = await exportPagedBulletinToDirectory(contract, election.electionID, SPOOL);
  } finally {
    gateway.close();
  }
  const exportMs = Number(process.hrtime.bigint() - exportStarted) / 1e6;
  if (exported.index.ballotCount !== BALLOTS || exported.board.encryptedBallots.length !== BALLOTS) {
    throw new Error('paged export ballot count mismatch');
  }
  const after = systemSnapshot();
  const successes = submitted.results;
  const evidence = {
    schema: 'mongbas-same-election-paged-benchmark/v1',
    createdAt: new Date().toISOString(), electionID: election.electionID,
    config: { ballots: BALLOTS, offeredRate: RATE, maxInFlight: MAX_IN_FLIGHT,
      encryptionMode: 'elgamal-vector-v3', candidates: CANDIDATES.length,
      credentialSetup: 'trusted-local-issuer-with-chaincode-verified-Ed25519-credential',
      eligibilityClaim: false, rateLimitsDisabled: true },
    cast: { attempted: BALLOTS, committed: successes.length, failed: 0,
      elapsedMs: +submitted.elapsedMs.toFixed(3), voterOperationsPerSecond: +(BALLOTS / (submitted.elapsedMs / 1000)).toFixed(6),
      maximumInFlight: submitted.maximumInFlight, latencyMs: stats(successes.map(result => result.ms)),
      prepareCommitLatencyMs: stats(successes.map(result => result.prepareMs)),
      castCommitLatencyMs: stats(successes.map(result => result.castMs)),
      scheduleLagMs: stats(successes.map(result => result.scheduleLagMs)),
      credentialAndProofGenerationMs: stats(submitted.generationMs) },
    tally,
    auditPublication: { milliseconds: +publishMs.toFixed(3), status: publish.status },
    pagedExport: { milliseconds: +exportMs.toFixed(3), indexHash: exported.index.indexHash,
      fetchedPages: exported.fetchedPages, ballots: exported.index.ballotCount,
      receipts: exported.index.receiptCount, disclosures: exported.index.disclosureCount,
      assembledBytes: fs.statSync(path.join(SPOOL, 'bulletin-board.json')).size },
    snapshots: { before, after },
    evidenceValid: true,
    claimBoundary: 'Performance and exact-tally evidence only; trusted local issuance is not an eligibility or independent-governance result.',
  };
  writeJsonEvidenceExclusive(OUT, evidence);
  process.stdout.write(`${JSON.stringify({ schema: evidence.schema, electionID: evidence.electionID,
    ballots: BALLOTS, cast: evidence.cast, tally, auditPublication: evidence.auditPublication,
    pagedExport: evidence.pagedExport, evidenceValid: true })}\n`);
}

main().catch(error => {
  process.stderr.write(`same-election paged benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
});
