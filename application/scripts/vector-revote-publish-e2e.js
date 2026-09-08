#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { generateVectorBallot } = require('../src/lib/vectorElgamal');

const baseURL = String(process.env.E2E_BASE_URL || 'http://127.0.0.1:3004').replace(/\/$/, '');
const adminToken = process.env.ADMIN_API_TOKEN || '';
const electionID = process.env.E2E_ELECTION_ID || `vector-revote-publish-${Date.now()}`;
const candidates = ['A', 'B', 'C'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function request(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function cast(credential, publicKey, nullifierHash, candidateIndex) {
  const ballot = generateVectorBallot(publicKey, candidateIndex, candidates.length);
  const common = {
    electionID,
    nullifierHash,
    encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: ballot.vectorBallotValidityProof,
    credentialType: 'real',
  };
  const prepared = await request('/api/vote/prepare-vector', {
    method: 'POST',
    headers: { 'x-idemix-credential': credential },
    body: JSON.stringify({ ...common, clientNonceHash: sha256(crypto.randomBytes(32)) }),
  });
  return request('/api/vote/cast-vector', {
    method: 'POST',
    headers: { 'x-idemix-credential': credential },
    body: JSON.stringify({ ...common, ballotID: prepared.ballotID }),
  });
}

async function main() {
  if (adminToken.length < 32) throw new Error('ADMIN_API_TOKEN is required');
  const now = Math.floor(Date.now() / 1000);
  await request('/api/elections', { method: 'POST', body: JSON.stringify({
    electionID, title: 'Vector revote publish regression', candidates,
    startTime: now - 5, endTime: now + 3600, encryptionMode: 'elgamal-vector-v3',
  }) });
  await request(`/api/elections/${encodeURIComponent(electionID)}/activate`, { method: 'POST', body: '{}' });
  const { pubKey } = await request(`/api/elections/${encodeURIComponent(electionID)}/elgamal-pubkey`);
  const { blindingFactor } = await request(`/api/elections/${encodeURIComponent(electionID)}/blinding-factor`);
  const issued = await request('/api/credential/idemix', { method: 'POST', body: JSON.stringify({
    enrollmentID: 'demo001', enrollmentSecret: 'demo001pw', electionID,
  }) });
  const nullifierHash = sha256(issued.nullifierMaterial + electionID + blindingFactor);

  const casts = [];
  for (const candidateIndex of [0, 1, 2]) {
    casts.push(await cast(issued.credential, pubKey, nullifierHash, candidateIndex));
  }
  if (casts[0].isRevote === true || casts[1].isRevote !== true || casts[2].isRevote !== true ||
      casts[1].evictCount !== 1 || casts[2].evictCount !== 2) {
    throw new Error(`unexpected revote classification: ${JSON.stringify(casts)}`);
  }

  const snapshot = await request(`/api/elections/${encodeURIComponent(electionID)}/dashboard-snapshot`);
  if (snapshot.activeBallots !== 1 || snapshot.castEventCount !== 3) {
    throw new Error(`dashboard accounting mismatch: ${JSON.stringify(snapshot)}`);
  }

  await request(`/api/elections/${encodeURIComponent(electionID)}/close`, { method: 'POST' });
  for (const shareIndex of ['1', '2']) {
    await request(`/api/elections/${encodeURIComponent(electionID)}/partial-decryptions`, {
      method: 'POST', body: JSON.stringify({ shareIndex }),
    });
  }
  const tally = await request(`/api/elections/${encodeURIComponent(electionID)}/tally`);
  if (tally.totalVotes !== 1 || tally.results?.C !== 1 || tally.results?.A !== 0 || tally.results?.B !== 0) {
    throw new Error(`latest-ballot tally mismatch: ${JSON.stringify(tally)}`);
  }
  const verification = await request(`/api/elections/${encodeURIComponent(electionID)}/verify-elgamal`, { method: 'POST' });
  if (verification.isValid !== true) throw new Error(`ElGamal verification failed: ${JSON.stringify(verification)}`);

  const published = await request(`/api/elections/${encodeURIComponent(electionID)}/publish-audit`, { method: 'POST' });
  const board = await request(`/api/elections/${encodeURIComponent(electionID)}/bulletin-board`);
  if (!Array.isArray(board.encryptedBallots) || board.encryptedBallots.length !== 1 ||
      !Array.isArray(board.vectorBallotReceipts) || board.vectorBallotReceipts.length !== 1 ||
      board.electionID !== electionID) {
    throw new Error(`bulletin board mismatch: ${JSON.stringify(board)}`);
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'mongbas-vector-revote-publish-e2e/v1', electionID,
    attemptedCasts: 3, committedCastEvents: snapshot.castEventCount,
    activeBallots: snapshot.activeBallots, finalCandidate: 'C', tally: tally.results,
    receiptMismatchAbsent: true, publishSucceeded: true,
    publishedBallots: board.encryptedBallots.length,
    publishedActiveReceipts: board.vectorBallotReceipts.length,
    publishResponse: published,
    claimBoundary: 'Linux Fabric regression for bounded active-receipt lookup; not a coercion-resistance proof',
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`[FAIL] ${error.message}\n`);
  process.exitCode = 1;
});
