#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { connectGateway } = require('../src/gateway');
const { verifyAsymCredential } = require('../src/middleware/auth');
const { computeCredentialBoundNullifier } = require('../src/lib/credentialBinding');
const { computeCredentialRevocationHandle } = require('../src/lib/credentialRevocation');
const { submitTransactionAndWait } = require('../src/lib/submitTransaction');

const baseURL = String(process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminToken = process.env.ADMIN_API_TOKEN || '';
const runID = new Date().toISOString().replace(/[-:.TZ]/g, '');
const electionA = `DIRECT_CRED_A_${runID}`;
const electionB = `DIRECT_CRED_B_${runID}`;
const candidates = ['ALPHA', 'BRAVO'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function request(path, { admin = false, ...options } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* status is the only attack oracle */ }
  return { status: response.status, body };
}

function requireStatus(label, response, expected) {
  if (response.status !== expected) throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  return response.body;
}

async function createElection(electionID) {
  const now = Math.floor(Date.now() / 1000);
  requireStatus('create isolated election', await request('/api/elections', { admin: true, method: 'POST',
    body: JSON.stringify({ electionID, title: 'Direct Fabric credential attack fixture', candidates,
      startTime: now - 5, endTime: now + 3600, encryptionMode: 'aes' }) }), 201);
  requireStatus('activate isolated election', await request(`/api/elections/${electionID}/activate`, {
    admin: true, method: 'POST', body: '{}',
  }), 200);
  return requireStatus('read blinding factor', await request(`/api/elections/${electionID}/blinding-factor`), 200).blindingFactor;
}

async function issueAdmissionCredential(electionID) {
  const admission = requireStatus('issue admission', await request('/api/credential/demo-admission', {
    admin: true, method: 'POST', body: JSON.stringify({ electionID, ttlSeconds: 120 }),
  }), 201);
  const issued = requireStatus('redeem admission', await request('/api/credential/demo-admission/redeem', {
    method: 'POST', body: JSON.stringify({ electionID, token: admission.token }),
  }), 200);
  const verified = verifyAsymCredential(issued.credential);
  if (!verified.valid || verified.electionID !== electionID || !verified.expUnix || !verified.nullifierMaterial) {
    throw new Error('issued asymmetric credential did not verify locally');
  }
  return { token: issued.credential, material: issued.nullifierMaterial,
    verification: { credType: 'ed25519', electionID, expUnix: verified.expUnix,
      credHash: sha256(issued.credential) } };
}

function transientFor({ electionID, nullifierHash, credential, overrides = {}, omit = [] }) {
  const transient = {
    credentialVerification: Buffer.from(JSON.stringify(credential.verification)),
    credentialToken: Buffer.from(credential.token),
    castHistoryCommitmentNonce: Buffer.from(crypto.randomBytes(32).toString('hex')),
    castHistoryReceiptNonce: Buffer.from(crypto.randomBytes(32).toString('hex')),
    votePrivate: Buffer.from(JSON.stringify({ docType: 'votePrivate', electionID, nullifierHash,
      voteHash: sha256(crypto.randomBytes(32)) })),
    ...overrides,
  };
  omit.forEach(key => { delete transient[key]; });
  return transient;
}

async function rejected(contract, label, argumentsList, transientData) {
  try {
    await submitTransactionAndWait(contract, 'CastVoteWithHistory', argumentsList, { transientData });
  } catch (_) {
    process.stdout.write(`[REJECTED] ${label}\n`);
    return;
  }
  throw new Error(`${label}: direct Fabric attack unexpectedly committed`);
}

async function main() {
  if (adminToken.length < 32) throw new Error('ADMIN_API_TOKEN is required');
  const health = requireStatus('health', await request('/health'), 200);
  if (health?.idemix?.asymEnabled !== true || health?.demo?.admissionRequired !== true) {
    throw new Error('the isolated attack requires the asymmetric bounded QR credential profile');
  }
  const [blindingA, blindingB] = await Promise.all([createElection(electionA), createElection(electionB)]);
  const credentialA = await issueAdmissionCredential(electionA);
  const credentialB = await issueAdmissionCredential(electionB);
  const nullifierA = computeCredentialBoundNullifier(credentialA.material, electionA, blindingA);
  const nullifierB = computeCredentialBoundNullifier(credentialB.material, electionB, blindingB);
  const connection = await connectGateway();
  try {
    const argsA = [electionA, candidates[0], nullifierA];
    await rejected(connection.contract, 'missing credential verification', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA,
        omit: ['credentialVerification'] }));
    await rejected(connection.contract, 'malformed credential verification', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA,
        overrides: { credentialVerification: Buffer.from('{') } }));
    await rejected(connection.contract, 'unknown credential type', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA,
        overrides: { credentialVerification: Buffer.from(JSON.stringify({ ...credentialA.verification, credType: 'unknown' })) } }));
    await rejected(connection.contract, 'expired credential metadata', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA,
        overrides: { credentialVerification: Buffer.from(JSON.stringify({ ...credentialA.verification, expUnix: 1 })) } }));
    await rejected(connection.contract, 'forged credential token', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA,
        overrides: { credentialToken: Buffer.from(`${credentialA.token.slice(0, -1)}${credentialA.token.endsWith('A') ? 'B' : 'A'}`) } }));
    await rejected(connection.contract, 'arbitrary nullifier', [electionA, candidates[0], 'f'.repeat(64)],
      transientFor({ electionID: electionA, nullifierHash: 'f'.repeat(64), credential: credentialA }));
    await rejected(connection.contract, 'cross-election credential', [electionB, candidates[0], nullifierA],
      transientFor({ electionID: electionB, nullifierHash: nullifierA, credential: credentialA }));
    await rejected(connection.contract, 'missing history nonce', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA,
        omit: ['castHistoryReceiptNonce'] }));

    const revocationHandle = computeCredentialRevocationHandle(credentialA.material, electionA, blindingA);
    requireStatus('revoke credential', await request(`/api/elections/${electionA}/revoke-credential`, {
      admin: true, method: 'POST', body: JSON.stringify({ revocationHandle, reasonCode: 'credential-compromised' }),
    }), 200);
    await rejected(connection.contract, 'revoked credential', argsA,
      transientFor({ electionID: electionA, nullifierHash: nullifierA, credential: credentialA }));

    await submitTransactionAndWait(connection.contract, 'CastVoteWithHistory',
      [electionB, candidates[1], nullifierB], { transientData: transientFor({
        electionID: electionB, nullifierHash: nullifierB, credential: credentialB }) });
    const committed = JSON.parse(Buffer.from(await connection.contract.evaluateTransaction('GetNullifier', nullifierB)).toString('utf8'));
    if (committed.nullifierHash !== nullifierB || !String(committed.credVerifyLevel || '').startsWith('chaincode-')) {
      throw new Error('positive-control vote lacks chaincode credential evidence');
    }
  } finally {
    connection.gateway.close();
  }

  process.stdout.write(`${JSON.stringify({ schema: 'mongbas-direct-fabric-credential-attack/v1',
    rejected: 9, positiveControlCommitted: true, credentialMode: 'ed25519',
    attacks: ['missing-verification', 'malformed-verification', 'unknown-type', 'expired-metadata', 'forged-token',
      'arbitrary-nullifier', 'cross-election', 'missing-history-nonce', 'revoked-credential'] })}\n`);
}

main().catch(error => {
  process.stderr.write(`direct Fabric credential attack failed: ${error.message}\n`);
  process.exitCode = 1;
});
