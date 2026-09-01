#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { generateVectorBallot, verifyVectorAuditWitness } = require('../src/lib/vectorElgamal');

const BASE_URL = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const ELECTION_ID = process.env.E2E_ELECTION_ID || `vector-aoc-${Date.now()}`;
const CANDIDATES = ['A', 'B', 'C'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, { ...options, headers: {
    'content-type': 'application/json', ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
    ...(options.headers || {}),
  } });
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: response.ok, status: response.status, body };
}

async function ok(label, promise) {
  const result = await promise;
  if (!result.ok) throw new Error(`${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  process.stdout.write(`[OK] ${label}\n`);
  return result.body;
}

async function rejected(label, promise) {
  const result = await promise;
  if (result.ok) throw new Error(`${label}: unexpectedly succeeded`);
  process.stdout.write(`[OK] ${label}: rejected HTTP ${result.status}\n`);
  return result;
}

async function issue(voter, electionID) {
  const issued = await ok(`issue ${voter}`, request('/api/credential/idemix', { method: 'POST',
    body: JSON.stringify({ enrollmentID: voter, enrollmentSecret: `${voter}pw`, electionID }) }));
  if (!issued.credential || !issued.nullifierMaterial) throw new Error(`${voter}: incomplete credential`);
  return issued;
}

function ballotRequest(electionID, nullifierHash, ballot) {
  return { electionID, nullifierHash, encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: ballot.vectorBallotValidityProof };
}

async function prepare(headers, common) {
  const clientNonce = crypto.randomBytes(32).toString('hex');
  const receipt = await ok('prepare vector ballot', request('/api/vote/prepare-vector', { method: 'POST', headers,
    body: JSON.stringify({ ...common, clientNonceHash: sha256(clientNonce) }) }));
  if (!receipt.ballotID || receipt.status !== 'prepared') throw new Error('invalid prepared receipt');
  return { receipt, clientNonce };
}

async function main() {
  if (!ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN is required');
  await ok('health', request('/health'));
  const now = Math.floor(Date.now() / 1000);
  await ok('create election', request('/api/elections', { method: 'POST', body: JSON.stringify({
    electionID: ELECTION_ID, title: 'Vector audit-or-cast E2E', candidates: CANDIDATES,
    startTime: now - 10, endTime: now + 3600, encryptionMode: 'elgamal-vector-v3',
  }) }));
  await ok('activate election', request(`/api/elections/${encodeURIComponent(ELECTION_ID)}/activate`, { method: 'POST', body: '{}' }));
  const keyBody = await ok('public key', request(`/api/elections/${encodeURIComponent(ELECTION_ID)}/elgamal-pubkey`));
  const pubKey = keyBody.pubKey || keyBody;
  const blind = await ok('blinding factor', request(`/api/elections/${encodeURIComponent(ELECTION_ID)}/blinding-factor`));

  const auditCredential = await issue('demo001', ELECTION_ID);
  const auditNullifier = sha256(auditCredential.nullifierMaterial + ELECTION_ID + blind.blindingFactor);
  const auditHeaders = { 'x-idemix-credential': auditCredential.credential };
  const auditBallot = generateVectorBallot(pubKey, 1, CANDIDATES.length);
  if (!verifyVectorAuditWitness(pubKey, auditBallot.encryptedCandidateVector, auditBallot._auditWitness)) throw new Error('local witness rejected');
  const auditedPrepared = await prepare(auditHeaders, ballotRequest(ELECTION_ID, auditNullifier, auditBallot));
  const auditBody = { electionID: ELECTION_ID, ballotID: auditedPrepared.receipt.ballotID, nullifierHash: auditNullifier,
    selectedIndex: auditBallot._auditWitness.selectedIndex, clientNonce: auditedPrepared.clientNonce,
    randomness: auditBallot._auditWitness.randomness };
  const disclosure = await ok('audit prepared ballot', request('/api/vote/audit-vector', { method: 'POST', headers: auditHeaders, body: JSON.stringify(auditBody) }));
  if (disclosure.status !== 'audited' || disclosure.selectedIndex !== 1) throw new Error('invalid audit disclosure');
  await rejected('repeat audit', request('/api/vote/audit-vector', { method: 'POST', headers: auditHeaders, body: JSON.stringify(auditBody) }));
  await rejected('audit then cast', request('/api/vote/cast-vector', { method: 'POST', headers: auditHeaders,
    body: JSON.stringify({ ...ballotRequest(ELECTION_ID, auditNullifier, auditBallot), ballotID: auditedPrepared.receipt.ballotID }) }));

  const castCredential = await issue('demo002', ELECTION_ID);
  const castNullifier = sha256(castCredential.nullifierMaterial + ELECTION_ID + blind.blindingFactor);
  const castHeaders = { 'x-idemix-credential': castCredential.credential };
  const castBallot = generateVectorBallot(pubKey, 0, CANDIDATES.length);
  const castCommon = ballotRequest(ELECTION_ID, castNullifier, castBallot);
  await rejected('direct vector CastVote bypass', request('/api/vote', { method: 'POST', headers: castHeaders, body: JSON.stringify(castCommon) }));
  const castPrepared = await prepare(castHeaders, castCommon);
  const castBody = { ...castCommon, ballotID: castPrepared.receipt.ballotID };
  await ok('cast prepared ballot', request('/api/vote/cast-vector', { method: 'POST', headers: castHeaders, body: JSON.stringify(castBody) }));
  await rejected('repeat cast', request('/api/vote/cast-vector', { method: 'POST', headers: castHeaders, body: JSON.stringify(castBody) }));
  await rejected('cast then audit', request('/api/vote/audit-vector', { method: 'POST', headers: castHeaders,
    body: JSON.stringify({ electionID: ELECTION_ID, ballotID: castPrepared.receipt.ballotID, nullifierHash: castNullifier,
      selectedIndex: 0, clientNonce: castPrepared.clientNonce, randomness: castBallot._auditWitness.randomness }) }));

  const tamperCredential = await issue('demo003', ELECTION_ID);
  const tamperNullifier = sha256(tamperCredential.nullifierMaterial + ELECTION_ID + blind.blindingFactor);
  const tamperHeaders = { 'x-idemix-credential': tamperCredential.credential };
  const tamperBallot = generateVectorBallot(pubKey, 2, CANDIDATES.length);
  const tamperCommon = ballotRequest(ELECTION_ID, tamperNullifier, tamperBallot);
  const tamperPrepared = await prepare(tamperHeaders, tamperCommon);
  const changed = structuredClone(tamperCommon);
  changed.encryptedCandidateVector[0].c2 = changed.encryptedCandidateVector[0].c2 === '1' ? '2' : '1';
  await rejected('changed artifact cast', request('/api/vote/cast-vector', { method: 'POST', headers: tamperHeaders,
    body: JSON.stringify({ ...changed, ballotID: tamperPrepared.receipt.ballotID }) }));
  await ok('correct artifact survives failed tamper', request('/api/vote/cast-vector', { method: 'POST', headers: tamperHeaders,
    body: JSON.stringify({ ...tamperCommon, ballotID: tamperPrepared.receipt.ballotID }) }));

  const raceCredential = await issue('demo004', ELECTION_ID);
  const raceNullifier = sha256(raceCredential.nullifierMaterial + ELECTION_ID + blind.blindingFactor);
  const raceHeaders = { 'x-idemix-credential': raceCredential.credential };
  const raceBallot = generateVectorBallot(pubKey, 1, CANDIDATES.length);
  const raceCommon = ballotRequest(ELECTION_ID, raceNullifier, raceBallot);
  const racePrepared = await prepare(raceHeaders, raceCommon);
  const raceAuditBody = { electionID: ELECTION_ID, ballotID: racePrepared.receipt.ballotID, nullifierHash: raceNullifier,
    selectedIndex: 1, clientNonce: racePrepared.clientNonce, randomness: raceBallot._auditWitness.randomness };
  const [raceAudit, raceCast] = await Promise.all([
    request('/api/vote/audit-vector', { method: 'POST', headers: raceHeaders, body: JSON.stringify(raceAuditBody) }),
    request('/api/vote/cast-vector', { method: 'POST', headers: raceHeaders,
      body: JSON.stringify({ ...raceCommon, ballotID: racePrepared.receipt.ballotID }) }),
  ]);
  if (Number(raceAudit.ok) + Number(raceCast.ok) !== 1) {
    throw new Error(`concurrent audit/cast must commit exactly one: audit=${raceAudit.status} cast=${raceCast.status}`);
  }
  process.stdout.write(`[OK] concurrent audit/cast committed exactly one (${raceAudit.ok ? 'audit' : 'cast'})\n`);

  process.stdout.write(`${JSON.stringify({ schema: 'mongbas-vector-audit-or-cast-e2e/v1', electionID: ELECTION_ID,
    preparedAuditCastMutuallyExclusive: true, directCastRejected: true, artifactTamperRejected: true,
    concurrentTerminalCommitExactlyOne: true, localWitnessVerified: true,
    claimBoundary: 'state-machine E2E; independent bundle verification remains separate' })}\n`);
}

main().catch(error => { process.stderr.write(`[FAIL] ${error.message}\n`); process.exitCode = 1; });
