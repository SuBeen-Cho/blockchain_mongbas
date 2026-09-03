#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { generateVectorBallot } = require('../src/lib/vectorElgamal');

const baseURL = String(process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminToken = process.env.ADMIN_API_TOKEN || '';
const electionID = process.env.E2E_ELECTION_ID || `QR_LIVE_${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
const reuseElection = process.env.E2E_REUSE_ELECTION === 'true';
const revoteSameCredential = process.env.E2E_REVOTE_SAME_CREDENTIAL === 'true';
const candidates = ['ALPHA', 'BRAVO', 'CHARLIE'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function request(path, { admin = false, credential = '', ...options } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(credential ? { 'x-idemix-credential': credential } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, ok: response.ok, body };
}

function requireStatus(label, result, expected) {
  if (result.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${result.status}`);
  }
  return result.body;
}

async function main() {
  if (adminToken.length < 32) throw new Error('ADMIN_API_TOKEN is required');
  const health = requireStatus('health', await request('/health'), 200);
  if (health.demo?.endpointsEnabled !== true || health.demo?.admissionRequired !== true ||
      health.benchmark?.rateLimitsDisabled !== false) {
    throw new Error('backend is not using the bounded QR admission profile');
  }

  let initialCount = 0;
  let initialRows = 0;
  if (reuseElection) {
    initialCount = requireStatus('read initial live count',
      await request(`/api/elections/${electionID}/live-count`, { admin: true }), 200).totalVotes;
    initialRows = requireStatus('read initial live votes',
      await request(`/api/elections/${electionID}/live-votes`, { admin: true }), 200).votes.length;
  } else {
    const now = Math.floor(Date.now() / 1000);
    requireStatus('create election', await request('/api/elections', {
      admin: true, method: 'POST', body: JSON.stringify({ electionID, title: 'QR live E2E', candidates,
        startTime: now - 5, endTime: now + 3600, encryptionMode: 'elgamal-vector-v3' }),
    }), 201);
    requireStatus('activate election', await request(`/api/elections/${electionID}/activate`, {
      admin: true, method: 'POST', body: '{}',
    }), 200);
  }

  requireStatus('unauthorized issue', await request('/api/credential/demo-admission', {
    method: 'POST', body: JSON.stringify({ electionID, ttlSeconds: 120 }),
  }), 401);
  const admission = requireStatus('authorized issue', await request('/api/credential/demo-admission', {
    admin: true, method: 'POST', body: JSON.stringify({ electionID, ttlSeconds: 120 }),
  }), 201);
  if (!/^[A-Za-z0-9_-]{43}$/.test(admission?.token || '')) throw new Error('admission token shape is invalid');
  requireStatus('wrong-election redemption', await request('/api/credential/demo-admission/redeem', {
    method: 'POST', body: JSON.stringify({ electionID: `${electionID}_WRONG`, token: admission.token }),
  }), 401);
  const issued = requireStatus('first redemption', await request('/api/credential/demo-admission/redeem', {
    method: 'POST', body: JSON.stringify({ electionID, token: admission.token }),
  }), 200);
  requireStatus('replay redemption', await request('/api/credential/demo-admission/redeem', {
    method: 'POST', body: JSON.stringify({ electionID, token: admission.token }),
  }), 401);
  if (!issued?.credential || !issued?.nullifierMaterial) throw new Error('credential binding material is missing');

  const election = requireStatus('get election', await request(`/api/elections/${electionID}`), 200);
  const publicKey = requireStatus('get public key', await request(`/api/elections/${electionID}/elgamal-pubkey`), 200).pubKey;
  const blindingFactor = requireStatus('get blinding factor',
    await request(`/api/elections/${electionID}/blinding-factor`), 200).blindingFactor;
  if (election.encryptionMode !== 'elgamal-vector-v3' || !publicKey || !blindingFactor) {
    throw new Error('vector-v3 election context is incomplete');
  }

  const nullifierHash = sha256(issued.nullifierMaterial + electionID + blindingFactor);
  const ballot = generateVectorBallot(publicKey, 1, candidates.length);
  const common = { electionID, nullifierHash, encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: ballot.vectorBallotValidityProof, credentialType: 'real' };
  const prepared = requireStatus('prepare vector ballot', await request('/api/vote/prepare-vector', {
    credential: issued.credential, method: 'POST',
    body: JSON.stringify({ ...common, clientNonceHash: sha256(crypto.randomBytes(32)) }),
  }), 200);
  if (!prepared?.ballotID) throw new Error('prepared ballot identifier is missing');
  const cast = requireStatus('cast vector ballot', await request('/api/vote/cast-vector', {
    credential: issued.credential, method: 'POST', body: JSON.stringify({ ...common, ballotID: prepared.ballotID }),
  }), 200);

  let revote = null;
  if (revoteSameCredential) {
    const replacement = generateVectorBallot(publicKey, 2, candidates.length);
    const replacementCommon = { ...common, encryptedCandidateVector: replacement.encryptedCandidateVector,
      vectorBallotValidityProof: replacement.vectorBallotValidityProof };
    const replacementPrepared = requireStatus('prepare replacement vector ballot',
      await request('/api/vote/prepare-vector', { credential: issued.credential, method: 'POST',
        body: JSON.stringify({ ...replacementCommon, clientNonceHash: sha256(crypto.randomBytes(32)) }) }), 200);
    revote = requireStatus('cast replacement vector ballot', await request('/api/vote/cast-vector', {
      credential: issued.credential, method: 'POST',
      body: JSON.stringify({ ...replacementCommon, ballotID: replacementPrepared.ballotID }),
    }), 200);
    if (revote.isRevote !== true || !Number.isSafeInteger(revote.evictCount) || revote.evictCount < 1) {
      throw new Error('same-credential replacement was not classified as a revote');
    }
  }

  requireStatus('emit authenticated dashboard event', await request('/api/vote/demo-event', {
    credential: issued.credential, method: 'POST', body: JSON.stringify({ electionID, nullifierHash }),
  }), 200);
  const liveCount = requireStatus('read live count', await request(`/api/elections/${electionID}/live-count`, { admin: true }), 200);
  const liveVotes = requireStatus('read live votes', await request(`/api/elections/${electionID}/live-votes`, { admin: true }), 200);
  const events = requireStatus('read dashboard events', await request(`/api/elections/${electionID}/demo-events?since=0`, { admin: true }), 200);
  const ledgerLookup = requireStatus('read committed nullifier', await request(`/api/nullifier/${nullifierHash}`), 200);
  const expectedRows = initialRows + (revoteSameCredential ? 2 : 1);
  if (liveCount.totalVotes !== initialCount + 1 || liveVotes.votes?.length !== expectedRows ||
      !events.events?.some(event => event.type === 'verify') || !ledgerLookup.credVerifyLevel?.startsWith('chaincode-')) {
    throw new Error('dashboard or Fabric post-cast evidence is incomplete');
  }

  process.stdout.write(`${JSON.stringify({ schema: 'mongbas-qr-admission-live-e2e/v1', electionID,
    reusedElection: reuseElection, sameCredentialRevote: revoteSameCredential, encryptionMode: election.encryptionMode,
    admission: { unauthorizedIssue: 401, wrongElection: 401,
      firstRedemption: 200, replay: 401 }, cast: { prepared: true, committed: true,
      isRevote: Boolean(cast.isRevote), replacementCommitted: Boolean(revote),
      replacementEvictCount: revote?.evictCount ?? 0, credentialVerification: ledgerLookup.credVerifyLevel },
    dashboard: { totalVotes: liveCount.totalVotes, encryptedRows: liveVotes.votes.length,
      verificationEvent: true } }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`QR admission live E2E failed: ${error.message}\n`);
  process.exitCode = 1;
});
