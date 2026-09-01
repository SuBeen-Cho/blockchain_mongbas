#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const { computeCredentialBoundNullifier } = require('../src/lib/credentialBinding');

const DEFAULT_BASE_URL = process.env.E2E_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const DEFAULT_ELECTION_ID = process.env.E2E_ELECTION_ID || `ed25519-e2e-${Date.now()}`;
const DEFAULT_CANDIDATES = (process.env.E2E_CANDIDATES || 'CANDIDATE_A,CANDIDATE_B')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function usage() {
  console.log(`Usage:
  node scripts/ed25519-e2e-smoke.js [options]

Options:
  --base-url <url>       REST API base URL (default: ${DEFAULT_BASE_URL})
  --election-id <id>     Election ID (default: ${DEFAULT_ELECTION_ID})
  --candidate-id <id>    Candidate to vote for (default: first candidate)
  --prepare              Create and activate the election if needed
  --help                 Show this help

Environment:
  ASYM_CRED_ENABLED=true and IDEMIX_ENABLED=true must be set on the running API server.
  ED25519_PUBLIC_KEY_DER_B64 must be set on the chaincode container for on-chain verification.
`);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL.replace(/\/$/, ''),
    electionID: DEFAULT_ELECTION_ID,
    candidateID: DEFAULT_CANDIDATES[0],
    candidates: DEFAULT_CANDIDATES,
    prepare: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--prepare') {
      opts.prepare = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) throw new Error(`${arg} requires a value`);
    if (arg === '--base-url') opts.baseUrl = next.replace(/\/$/, '');
    else if (arg === '--election-id') opts.electionID = next;
    else if (arg === '--candidate-id') opts.candidateID = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!opts.candidates.includes(opts.candidateID)) {
    opts.candidates = [opts.candidateID, ...opts.candidates.filter((c) => c !== opts.candidateID)];
  }
  if (opts.candidates.length < 2) {
    throw new Error('At least two candidates are required');
  }
  return opts;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function decodeJsonB64Url(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function mutateTokenSignature(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Expected header.payload.signature token');
  // Flip a byte in the middle of the signature to avoid base64url padding bits
  const sigBuf = Buffer.from(parts[2], 'base64url');
  sigBuf[0] = sigBuf[0] ^ 0xff; // invert first byte
  parts[2] = sigBuf.toString('base64url');
  return parts.join('.');
}

function mutateTokenPayload(token, patch) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Expected header.payload.signature token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  Object.assign(payload, patch);
  parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // signature is now invalid since payload changed
  return parts.join('.');
}

function mutateTokenHeader(token, patch) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Expected header.payload.signature token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  Object.assign(header, patch);
  parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
  return parts.join('.');
}

function stripTokenSignature(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Expected header.payload.signature token');
  return `${parts[0]}.${parts[1]}.`;
}

async function requestJson(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, ok: res.ok, body };
}

async function assertOk(label, promise) {
  const res = await promise;
  if (!res.ok) {
    throw new Error(`${label} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[OK] ${label}`);
  return res.body;
}

async function assertRejected(label, promise) {
  const res = await promise;
  if (res.ok) {
    throw new Error(`${label} unexpectedly succeeded: ${JSON.stringify(res.body)}`);
  }
  console.log(`[OK] ${label} rejected with HTTP ${res.status}`);
  return res.body;
}

async function prepareElection(opts) {
  const existing = await requestJson(opts.baseUrl, `/api/elections/${encodeURIComponent(opts.electionID)}`);
  if (existing.ok) {
    console.log(`[OK] election already exists: ${opts.electionID}`);
    if (existing.body.status === 'ACTIVE') return;
    await assertOk('activate existing election', requestJson(
      opts.baseUrl,
      `/api/elections/${encodeURIComponent(opts.electionID)}/activate`,
      { method: 'POST', body: '{}' },
    ));
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  await assertOk('create election', requestJson(opts.baseUrl, '/api/elections', {
    method: 'POST',
    body: JSON.stringify({
      electionID: opts.electionID,
      title: `Ed25519 E2E ${opts.electionID}`,
      description: 'Generated by ed25519-e2e-smoke.js',
      candidates: opts.candidates,
      startTime: now - 10,
      endTime: now + 3600,
    }),
  }));
  await assertOk('activate election', requestJson(
    opts.baseUrl,
    `/api/elections/${encodeURIComponent(opts.electionID)}/activate`,
    { method: 'POST', body: '{}' },
  ));
}

async function issueCredential(opts, electionID) {
  const body = await assertOk(`issue credential for ${electionID}`, requestJson(
    opts.baseUrl,
    '/api/credential/idemix',
    {
      method: 'POST',
      body: JSON.stringify({
        enrollmentID: 'voter1',
        enrollmentSecret: 'voter1pw',
        electionID,
      }),
    },
  ));

  if (!body.credential) throw new Error('Credential response has no credential');
  if (body.credType !== 'Ed25519-asym') {
    throw new Error(`Expected Ed25519-asym credential, got ${body.credType}`);
  }
  return body.credential;
}

async function verifyCredentialLocally(opts, token, expectedElectionID) {
  const publicKeyResponse = await assertOk(
    'fetch Ed25519 public key',
    requestJson(opts.baseUrl, '/api/credential/public-key'),
  );
  const [headerB64, payloadB64, sigB64] = token.split('.');
  const header = decodeJsonB64Url(headerB64);
  const payload = decodeJsonB64Url(payloadB64);

  if (header.alg !== 'EdDSA') throw new Error(`Unexpected credential alg: ${header.alg}`);
  if (payload.electionID !== expectedElectionID) {
    throw new Error(`Credential election mismatch: ${payload.electionID}`);
  }
  if (payload.voterEligible !== '1') throw new Error('Credential voterEligible is not 1');
  if (Date.now() > payload.exp) throw new Error('Credential is already expired');

  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyResponse.publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const valid = crypto.verify(
    null,
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(sigB64, 'base64url'),
  );
  if (!valid) throw new Error('Local Ed25519 signature verification failed');
  console.log('[OK] local Ed25519 signature verification');
}

function credentialNullifierMaterial(credential) {
  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('Expected Ed25519 header.payload.signature credential');
  const payload = decodeJsonB64Url(parts[1]);
  if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
    throw new Error('Signed credential has no nullifier material');
  }
  return payload.nonce;
}

async function getNullifier(opts, credential) {
  const blinding = await assertOk('fetch blinding factor', requestJson(
    opts.baseUrl,
    `/api/elections/${encodeURIComponent(opts.electionID)}/blinding-factor`,
  ));
  return computeCredentialBoundNullifier(
    credentialNullifierMaterial(credential), opts.electionID, blinding.blindingFactor,
  );
}

async function submitVote(opts, credential, nullifierHash) {
  return requestJson(opts.baseUrl, '/api/vote', {
    method: 'POST',
    headers: {
      'x-idemix-credential': credential,
    },
    body: JSON.stringify({
      electionID: opts.electionID,
      candidateID: opts.candidateID,
      nullifierHash,
    }),
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log(`[INFO] baseUrl=${opts.baseUrl}`);
  console.log(`[INFO] electionID=${opts.electionID}`);
  console.log(`[INFO] candidateID=${opts.candidateID}`);

  await assertOk('API root reachable', requestJson(opts.baseUrl, '/'));
  if (opts.prepare) await prepareElection(opts);

  const credential = await issueCredential(opts, opts.electionID);
  await verifyCredentialLocally(opts, credential, opts.electionID);

  await assertRejected(
    'tampered credential vote',
    submitVote(opts, mutateTokenSignature(credential), await getNullifier(opts, credential)),
  );

  const wrongElectionCredential = await issueCredential(opts, `${opts.electionID}-wrong`);
  await assertRejected(
    'wrong-election credential vote',
    submitVote(opts, wrongElectionCredential, await getNullifier(opts, credential)),
  );

  // ── 추가 실패 조건 테스트 (8차) ────────────────────────────

  // 3. credential hash 불일치 (payload 변조 → 서명 무효화)
  await assertRejected(
    'payload-mutated credential (voterEligible=0)',
    submitVote(opts, mutateTokenPayload(credential, { voterEligible: '0' }), await getNullifier(opts, credential)),
  );

  // 4. header alg 변조 거부
  await assertRejected(
    'header alg-mutated credential (alg=RS256)',
    submitVote(opts, mutateTokenHeader(credential, { alg: 'RS256' }), await getNullifier(opts, credential)),
  );

  // 5. credentialToken 누락 거부 (헤더 없이 투표)
  await assertRejected(
    'missing credential token vote',
    requestJson(opts.baseUrl, '/api/vote', {
      method: 'POST',
      body: JSON.stringify({
        electionID: opts.electionID,
        candidateID: opts.candidateID,
        nullifierHash: await getNullifier(opts, credential),
      }),
    }),
  );

  // 6. 같은 토큰으로 다른 electionID 투표 거부 (request body의 electionID 변조)
  await assertRejected(
    'election-id mismatch in request body',
    requestJson(opts.baseUrl, '/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': credential },
      body: JSON.stringify({
        electionID: `${opts.electionID}-nonexistent`,
        candidateID: opts.candidateID,
        nullifierHash: await getNullifier(opts, credential),
      }),
    }),
  );

  // ── 정상 투표 (마지막) ────────────────────────────────────

  const voteBody = await assertOk(
    'valid Ed25519 credential vote',
    submitVote(opts, credential, await getNullifier(opts, credential)),
  );

  if (!voteBody.nullifierHash) throw new Error('Vote response has no nullifierHash');
  console.log(`[OK] valid vote nullifier=${voteBody.nullifierHash}`);
  console.log('[DONE] Ed25519 E2E smoke test completed (with extended failure conditions)');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { credentialNullifierMaterial, sha256Hex };
