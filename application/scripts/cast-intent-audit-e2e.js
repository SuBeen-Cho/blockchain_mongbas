#!/usr/bin/env node

'use strict';

const BASE_URL = (process.env.E2E_BASE_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const ELECTION_ID = process.env.E2E_ELECTION_ID || `audit-state-e2e-${Date.now()}`;

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: response.ok, status: response.status, body };
}

async function expectOk(label, promise) {
  const response = await promise;
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  process.stdout.write(`[OK] ${label}\n`);
  return response.body;
}

async function expectRejected(label, promise) {
  const response = await promise;
  if (response.ok) throw new Error(`${label}: unexpectedly succeeded`);
  process.stdout.write(`[OK] ${label}: rejected HTTP ${response.status}\n`);
}

async function main() {
  process.stdout.write(`[INFO] baseUrl=${BASE_URL}\n[INFO] electionID=${ELECTION_ID}\n`);
  await expectOk('API reachable', requestJson('/health'));
  const now = Math.floor(Date.now() / 1000);
  await expectOk('create AES audit election', requestJson('/api/elections', {
    method: 'POST',
    body: JSON.stringify({
      electionID: ELECTION_ID,
      title: `Audit state E2E ${ELECTION_ID}`,
      description: 'State-transition test; not vector-v3 cast-as-intended evidence',
      candidates: ['CANDIDATE_A', 'CANDIDATE_B'],
      encryptionMode: 'aes',
      startTime: now - 10,
      endTime: now + 3600,
    }),
  }));
  await expectOk('activate election', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/activate`, {
    method: 'POST', body: '{}',
  }));
  const issued = await expectOk('issue voter credential', requestJson('/api/credential/idemix', {
    method: 'POST',
    body: JSON.stringify({ enrollmentID: 'voter1', enrollmentSecret: 'voter1pw', electionID: ELECTION_ID }),
  }));
  if (!issued.credential) throw new Error('credential missing');
  const voterHeaders = { 'x-idemix-credential': issued.credential };
  const prepared = await expectOk('prepare ballot', requestJson('/api/vote/prepare', {
    method: 'POST', headers: voterHeaders,
    body: JSON.stringify({ electionID: ELECTION_ID, candidateID: 'CANDIDATE_A' }),
  }));
  if (!prepared.ballotID || prepared.status !== 'prepared') throw new Error('invalid prepared ballot response');
  const auditRequest = () => requestJson('/api/vote/audit', {
    method: 'POST', headers: voterHeaders,
    body: JSON.stringify({ electionID: ELECTION_ID, ballotID: prepared.ballotID }),
  });
  const audited = await expectOk('commit audit/spoil transition', auditRequest());
  if (audited.status !== 'audited' || audited.candidateID !== 'CANDIDATE_A' || !audited.encryptionKeyHex) {
    throw new Error('invalid audit disclosure');
  }
  await expectRejected('repeat audit of spoiled ballot', auditRequest());
  process.stdout.write(JSON.stringify({
    schema: 'mongbas-cast-intent-audit-e2e/v1',
    electionID: ELECTION_ID,
    preparedCommitted: true,
    auditedCommitted: true,
    repeatedAuditRejected: true,
    claimBoundary: 'AES state transition only; not vector-v3 cast-as-intended evidence',
  }) + '\n');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[FAIL] ${error.message}\n`);
    process.exitCode = 1;
  });
}
