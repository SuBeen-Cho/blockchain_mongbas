#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { generateVectorBallot } = require('../src/lib/vectorElgamal');
const { createVectorPartialDecryption } = require('../../trustee/src/dkg');

const BASE = process.env.MONGBAS_DKG_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const TRANSCRIPT_FILE = process.env.MONGBAS_DKG_TRANSCRIPT;
const SECRET_ROOT = process.env.MONGBAS_DKG_SECRET_ROOT;
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

function readPrivateShare(trusteeID) {
  const file = path.join(SECRET_ROOT, trusteeID, 'trustee-share.json');
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o777) !== 0o600) throw new Error(`loose trustee share permissions: ${trusteeID}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  if (!ADMIN_API_TOKEN || !TRANSCRIPT_FILE || !SECRET_ROOT) throw new Error('admin token, transcript and protected DKG secret root are required');
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

  for (let index = 0; index < CANDIDATES.length; index += 1) {
    const enrollmentID = `demo${String(index + 1).padStart(3, '0')}`;
    const issued = requireSuccess(await post('/api/credential/idemix', {
      enrollmentID, enrollmentSecret: `${enrollmentID}pw`, electionID,
    }), `credential ${index + 1}`);
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

  const partials = TRUSTEES.slice(0, 2).map(trustee => createVectorPartialDecryption({
    privateShare: readPrivateShare(trustee.id), electionID,
    encryptedAggregateVector: tally.encAggVector,
  }));
  const tampered = structuredClone(partials[0]);
  tampered.proofs[0].z = tampered.proofs[0].z === '1' ? '2' : '1';
  requireFailure(await post(`/api/elections/${electionID}/external-partial-decryptions`, {
    shareIndex: '1', partial: tampered,
  }), 'tampered external partial');
  requireSuccess(await post(`/api/elections/${electionID}/external-partial-decryptions`, {
    shareIndex: '1', partial: partials[0],
  }), 'valid external partial 1');
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
  process.stdout.write(`${JSON.stringify({
    success: true, electionID, keyCeremonyMode: 'dkg-v1', transcriptHash: transcript.transcriptHash,
    approvals: 3, rejected: ['pre-approval-activation', 'wrong-transcript-hash', 'shared-pdc-partial', 'tampered-partial', 'duplicate-partial'],
    totalVotes: tally.totalVotes, results: tally.results,
    externalPartialDecryptions: tally.vectorPartialDecryptions.length,
  })}\n`);
}

main().catch(error => { process.stderr.write(`[dkg-election-e2e] ${error.message}\n`); process.exit(1); });
