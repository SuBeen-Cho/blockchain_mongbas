#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { generateVectorBallot } = require('../src/lib/vectorElgamal');
const { createVectorPartialDecryption } = require('../../trustee/src/dkg');

const BASE = process.env.MONGBAS_DKG_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const TRANSCRIPT_FILE = process.env.MONGBAS_DKG_TRANSCRIPT;
const SECRET_ROOT = process.env.MONGBAS_DKG_SECRET_ROOT;
const PARTIAL_HELPER = process.env.MONGBAS_DKG_PARTIAL_HELPER || '';
const TRUSTEES = [
  { id: 'ElectionCommissionMSP', index: '1' },
  { id: 'PartyObserverMSP', index: '2' },
  { id: 'CivilSocietyMSP', index: '3' },
];
const CANDIDATES = ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'];

function request(method, pathname, body, headers = {}, timeoutMs = 180000) {
  return new Promise(resolve => {
    const url = new URL(pathname, BASE);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method, agent: false,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}), ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', error => resolve({ status: 0, body: { error: error.message } }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const get = pathname => request('GET', pathname);
const post = (pathname, body, headers) => request('POST', pathname, body, headers);
function requireSuccess(result, label) {
  if (result.status < 200 || result.status >= 300) throw new Error(`${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
function requireFailure(result, label) {
  if (result.status >= 200 && result.status < 300) throw new Error(`${label}: unexpectedly succeeded`);
}

async function issueCredential(electionID, enrollmentID) {
  const admission = requireSuccess(await post('/api/credential/demo-admission', {
    electionID, ttlSeconds: 120,
  }), `admission ${enrollmentID}`);
  if (!/^[A-Za-z0-9_-]{43}$/.test(admission?.token || '')) throw new Error(`admission token shape: ${enrollmentID}`);
  const issued = requireSuccess(await post('/api/credential/demo-admission/redeem', {
    electionID, token: admission.token,
  }), `redeem ${enrollmentID}`);
  if (!issued?.credential || !issued?.nullifierMaterial) throw new Error(`credential binding material: ${enrollmentID}`);
  return issued;
}

function readPrivateShare(trusteeID) {
  const file = path.join(SECRET_ROOT, trusteeID, 'trustee-share.json');
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o777) !== 0o600) throw new Error(`loose trustee share permissions: ${trusteeID}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createTrusteePartial(trustee, electionID, encryptedAggregateVector) {
  if (!PARTIAL_HELPER) {
    return createVectorPartialDecryption({
      privateShare: readPrivateShare(trustee.id), electionID, encryptedAggregateVector,
    });
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const aggregateFile = path.join(os.tmpdir(), `mongbas-dkg-aggregate-${nonce}.json`);
  const outputFile = path.join(os.tmpdir(), `mongbas-dkg-partial-${nonce}.json`);
  try {
    fs.writeFileSync(aggregateFile, `${JSON.stringify({ encAggVector: encryptedAggregateVector })}\n`, { flag: 'wx', mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(aggregateFile, 0o644);
    const generated = spawnSync(PARTIAL_HELPER, [trustee.id, trustee.index, electionID, aggregateFile, outputFile], {
      encoding: 'utf8', env: process.env, timeout: 180000,
    });
    if (generated.status !== 0) throw new Error(`trustee partial helper failed for ${trustee.id}: ${generated.stderr.trim()}`);
    const partial = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    if (partial.mspID !== trustee.id || String(partial.index) !== trustee.index) throw new Error(`helper output identity mismatch: ${trustee.id}`);
    return partial;
  } finally {
    for (const file of [aggregateFile, outputFile]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

async function main() {
  if (!ADMIN_API_TOKEN || !TRANSCRIPT_FILE || (!SECRET_ROOT && !PARTIAL_HELPER)) {
    throw new Error('admin token, transcript and either protected secret root or partial helper are required');
  }
  const transcript = JSON.parse(fs.readFileSync(TRANSCRIPT_FILE, 'utf8'));
  const electionID = `dkg-live-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const creation = requireSuccess(await post('/api/elections', {
    electionID, title: 'Live DKG election', description: 'external trustee integration evaluation',
    candidates: CANDIDATES, startTime: now, endTime: now + 1800,
    encryptionMode: 'elgamal-vector-v3', dkgTranscript: transcript,
  }), 'create DKG election');
  if (creation.keyCeremonyMode !== 'dkg-v1') throw new Error('backend did not select DKG ceremony mode');

  requireFailure(await post(`/api/elections/${electionID}/activate`, {}), 'activate before trustee approvals');
  requireFailure(await post(`/api/elections/${electionID}/dkg-approvals`, {
    shareIndex: '1', transcriptHash: '0'.repeat(64),
  }), 'wrong transcript approval');
  for (const trustee of TRUSTEES) {
    const election = requireSuccess(await post(`/api/elections/${electionID}/dkg-approvals`, {
      shareIndex: trustee.index, transcriptHash: transcript.transcriptHash,
    }), `approve ${trustee.id}`);
    if (!Array.isArray(election.dkgApprovals) || election.dkgApprovals.length !== Number(trustee.index)) {
      throw new Error(`approval count mismatch after ${trustee.id}`);
    }
  }
  requireSuccess(await post(`/api/elections/${electionID}/activate`, {}), 'activate DKG election');
  const pubKeyBody = requireSuccess(await get(`/api/elections/${electionID}/elgamal-pubkey`), 'DKG public key');
  const pubKey = pubKeyBody.pubKey || pubKeyBody;
  if (pubKey.y !== transcript.electionPublicKeyY) throw new Error('ledger public key differs from DKG transcript');
  const blinding = requireSuccess(await get(`/api/elections/${electionID}/blinding-factor`), 'blinding factor').blindingFactor;

  // Preserve a public audit-or-cast disclosure in the same DKG election so
  // bundle v5 proves both the key ceremony and cast-as-intended audit path.
  const auditEnrollmentID = 'demo004';
  const auditCredential = await issueCredential(electionID, auditEnrollmentID);
  const auditNullifierHash = crypto.createHash('sha256').update(auditCredential.nullifierMaterial + electionID + blinding).digest('hex');
  const auditBallot = generateVectorBallot(pubKey, 0, CANDIDATES.length);
  const auditNonce = crypto.randomBytes(32).toString('hex');
  const auditHeaders = { 'x-idemix-credential': auditCredential.credential };
  const auditPrepared = requireSuccess(await post('/api/vote/prepare-vector', {
    electionID, nullifierHash: auditNullifierHash,
    clientNonceHash: crypto.createHash('sha256').update(auditNonce).digest('hex'),
    encryptedCandidateVector: auditBallot.encryptedCandidateVector,
    vectorBallotValidityProof: auditBallot.vectorBallotValidityProof,
  }, auditHeaders), 'prepare audited DKG ballot');
  const auditDisclosure = requireSuccess(await post('/api/vote/audit-vector', {
    electionID, ballotID: auditPrepared.ballotID, nullifierHash: auditNullifierHash,
    selectedIndex: 0, clientNonce: auditNonce, randomness: auditBallot._auditWitness.randomness,
  }, auditHeaders), 'audit DKG ballot');
  if (auditDisclosure.status !== 'audited' || auditDisclosure.selectedIndex !== 0) throw new Error('DKG audit disclosure mismatch');

  for (let index = 0; index < CANDIDATES.length; index += 1) {
    const enrollmentID = `demo${String(index + 1).padStart(3, '0')}`;
    const issued = await issueCredential(electionID, enrollmentID);
    const nullifierHash = crypto.createHash('sha256').update(issued.nullifierMaterial + electionID + blinding).digest('hex');
    const ballot = generateVectorBallot(pubKey, index, CANDIDATES.length);
    const clientNonce = crypto.randomBytes(32).toString('hex');
    const headers = { 'x-idemix-credential': issued.credential };
    const prepared = requireSuccess(await post('/api/vote/prepare-vector', {
      electionID, nullifierHash,
      clientNonceHash: crypto.createHash('sha256').update(clientNonce).digest('hex'),
      encryptedCandidateVector: ballot.encryptedCandidateVector,
      vectorBallotValidityProof: ballot.vectorBallotValidityProof,
    }, headers), `prepare ${index + 1}`);
    requireSuccess(await post('/api/vote/cast-vector', {
      electionID, nullifierHash, ballotID: prepared.ballotID,
      encryptedCandidateVector: ballot.encryptedCandidateVector,
      vectorBallotValidityProof: ballot.vectorBallotValidityProof,
    }, headers), `cast ${index + 1}`);
  }

  requireSuccess(await post(`/api/elections/${electionID}/close`, {}), 'close/aggregate DKG election');
  let tally = requireSuccess(await get(`/api/elections/${electionID}/tally`), 'encrypted tally');
  if (tally.decrypted || !Array.isArray(tally.encAggVector) || tally.encAggVector.length !== CANDIDATES.length) {
    throw new Error('DKG tally was not left encrypted for external trustees');
  }
  requireFailure(await post(`/api/elections/${electionID}/partial-decryptions`, { shareIndex: '1' }), 'shared-PDC partial path');

  const partials = TRUSTEES.slice(0, 2).map(trustee => createTrusteePartial(trustee, electionID, tally.encAggVector));
  const tampered = structuredClone(partials[0]);
  tampered.proofs[0].z = tampered.proofs[0].z === '1' ? '2' : '1';
  requireFailure(await post(`/api/elections/${electionID}/external-partial-decryptions`, {
    shareIndex: '1', partial: tampered,
  }), 'tampered external partial');
  requireSuccess(await post(`/api/elections/${electionID}/external-partial-decryptions`, {
    shareIndex: '1', partial: partials[0],
  }), 'valid external partial 1');
  const belowThresholdTally = requireSuccess(await get(`/api/elections/${electionID}/tally`), 'threshold-minus-one tally');
  if (belowThresholdTally.decrypted !== false ||
      !Array.isArray(belowThresholdTally.vectorPartialDecryptions) ||
      belowThresholdTally.vectorPartialDecryptions.length !== 1) {
    throw new Error(`threshold-minus-one exposed a tally: ${JSON.stringify(belowThresholdTally)}`);
  }
  requireFailure(await post(`/api/elections/${electionID}/external-partial-decryptions`, {
    shareIndex: '1', partial: partials[0],
  }), 'duplicate external partial');
  requireSuccess(await post(`/api/elections/${electionID}/external-partial-decryptions`, {
    shareIndex: '2', partial: partials[1],
  }), 'valid external partial 2');

  tally = requireSuccess(await get(`/api/elections/${electionID}/tally`), 'decrypted DKG tally');
  const exact = tally.decrypted === true && tally.totalVotes === 3 &&
    CANDIDATES.every(candidate => tally.results?.[candidate] === 1) &&
    Array.isArray(tally.vectorPartialDecryptions) && tally.vectorPartialDecryptions.length === 2;
  if (!exact) throw new Error(`exact DKG tally mismatch: ${JSON.stringify(tally)}`);
  requireSuccess(await post(`/api/elections/${electionID}/publish-audit`, {}), 'publish DKG audit data');
  process.stdout.write(`${JSON.stringify({
    success: true, electionID, keyCeremonyMode: 'dkg-v1', transcriptHash: transcript.transcriptHash,
    approvals: 3, rejected: ['pre-approval-activation', 'wrong-transcript-hash', 'shared-pdc-partial', 'tampered-partial', 'threshold-minus-one', 'duplicate-partial'],
    totalVotes: tally.totalVotes, results: tally.results,
    externalPartialDecryptions: tally.vectorPartialDecryptions.length, auditedBallots: 1, auditPublished: true,
    credentialIssuance: 'one-use-demo-admission',
    partialGenerationMode: PARTIAL_HELPER ? 'external-helper' : 'in-process-secret-file',
  })}\n`);
}

main().catch(error => { process.stderr.write(`[dkg-election-e2e] ${error.message}\n`); process.exit(1); });
