#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { generateVectorBallot } = require('../src/lib/vectorElgamal');

const BASE = process.env.MONGBAS_PROBE_URL || 'http://127.0.0.1:3000';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const CANDIDATES = ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'];

function request(method, pathname, body, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const url = new URL(pathname, BASE);
    const payload = body == null ? null : JSON.stringify(body);
    const started = process.hrtime.bigint();
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path: url.pathname, method, agent: false,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { let parsed = raw; try { parsed = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, ms: Number(process.hrtime.bigint() - started) / 1e6 }); });
    });
    req.on('error', (error) => resolve({ status: 0, body: { error: error.message }, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (pathname, headers, timeout) => request('GET', pathname, null, headers, timeout);
const post = (pathname, body, headers, timeout) => request('POST', pathname, body, headers, timeout);
function requireStatus(result, label) {
  if (result.status < 200 || result.status >= 300) throw new Error(`${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function retryPartial(electionID, shareIndex) {
  const deadline = Date.now() + 60000;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const result = await post(`/api/elections/${electionID}/partial-decryptions`, { shareIndex }, {}, 120000);
    if (result.status >= 200 && result.status < 300) return { attempts, ms: result.ms };
    if (Date.now() >= deadline) requireStatus(result, `partial ${shareIndex}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

async function main() {
  if (!ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN is required');
  requireStatus(await get('/health'), 'health');
  const electionID = `fault-probe-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  requireStatus(await post('/api/elections', { electionID, title: 'Fault probe', description: 'single ballot resilience probe',
    candidates: CANDIDATES, startTime: now, endTime: now + 1800, encryptionMode: 'elgamal-vector-v3' }), 'create');
  requireStatus(await post(`/api/elections/${electionID}/activate`, {}), 'activate');
  const pubKeyBody = requireStatus(await get(`/api/elections/${electionID}/elgamal-pubkey`), 'public key');
  const pubKey = pubKeyBody.pubKey || pubKeyBody;
  const blinding = requireStatus(await get(`/api/elections/${electionID}/blinding-factor`), 'blinding factor').blindingFactor;
  const issued = requireStatus(await post('/api/credential/idemix', {
    enrollmentID: 'demo001', enrollmentSecret: 'demo001pw', electionID,
  }), 'credential');
  const nullifierHash = crypto.createHash('sha256').update(issued.nullifierMaterial + electionID + blinding).digest('hex');
  const ballot = generateVectorBallot(pubKey, 0, CANDIDATES.length);
  requireStatus(await post('/api/vote', { electionID, nullifierHash,
    encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: ballot.vectorBallotValidityProof },
  { 'x-idemix-credential': issued.credential }, 180000), 'vote');
  const close = await post(`/api/elections/${electionID}/close`, {}, {}, 300000);
  requireStatus(close, 'close/aggregate');
  const partial1 = await retryPartial(electionID, '1');
  const partial2 = await retryPartial(electionID, '2');
  const tallyResult = await get(`/api/elections/${electionID}/tally`, {}, 120000);
  const tally = requireStatus(tallyResult, 'tally');
  const exact = tally.decrypted === true && tally.totalVotes === 1 &&
    tally.results?.CANDIDATE_A === 1 && tally.results?.CANDIDATE_B === 0 && tally.results?.CANDIDATE_C === 0 &&
    Array.isArray(tally.vectorPartialDecryptions) && tally.vectorPartialDecryptions.length >= 2;
  if (!exact) throw new Error(`exact threshold tally mismatch: ${JSON.stringify(tally)}`);
  process.stdout.write(`${JSON.stringify({ success: true, electionID, closeMs: +close.ms.toFixed(1),
    tallyReadMs: +tallyResult.ms.toFixed(1), partialAttempts: [partial1.attempts, partial2.attempts],
    totalVotes: tally.totalVotes, results: tally.results, vectorPartialDecryptionProofs: tally.vectorPartialDecryptions.length })}\n`);
}

main().catch((error) => { process.stderr.write(`[fault-probe] ${error.message}\n`); process.exit(1); });
