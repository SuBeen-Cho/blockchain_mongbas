#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { generateVectorBallot } = require('../src/lib/vectorElgamal');
const { deriveLookupToken, RESPONSE_BYTES } = require('../src/lib/deniableProof');

const BASE_URL = (process.env.E2E_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ELECTION_ID = process.env.E2E_ELECTION_ID || `full-e2e-${Date.now()}`;
const CANDIDATES = ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'];
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body, bodyBytes: Buffer.byteLength(text, 'utf8') };
}

async function assertOk(label, promise) {
  const res = await promise;
  if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  console.log(`[OK] ${label}`);
  return res.body;
}

async function assertRejected(label, promise) {
  const res = await promise;
  if (res.ok) throw new Error(`${label} unexpectedly succeeded: ${JSON.stringify(res.body)}`);
  if (res.status >= 500) throw new Error(`${label} produced a server failure instead of an explicit rejection: HTTP ${res.status}`);
  console.log(`[OK] ${label} rejected with HTTP ${res.status}`);
  return res.body;
}

async function castPreparedVector(label, headers, electionID, nullifierHash, ballot) {
  const clientNonce = crypto.randomBytes(32).toString('hex');
  const common = {
    electionID, nullifierHash,
    encryptedCandidateVector: ballot.encryptedCandidateVector,
    vectorBallotValidityProof: ballot.vectorBallotValidityProof,
  };
  const prepared = await assertOk(`${label} prepare`, requestJson('/api/vote/prepare-vector', {
    method: 'POST', headers,
    body: JSON.stringify({ ...common, clientNonceHash: sha256Hex(clientNonce) }),
  }));
  if (!prepared.ballotID) throw new Error(`${label}: prepared ballotID missing`);
  return assertOk(`${label} cast`, requestJson('/api/vote/cast-vector', {
    method: 'POST', headers,
    body: JSON.stringify({ ...common, ballotID: prepared.ballotID }),
  }));
}

// [PAPER-1] AES-256-GCM 클라이언트-사이드 암호화 (blind mode 테스트용)
// 체인코드와 동일한 결정론적 nonce: SHA256(key + plaintext)[:12]
function encryptAESGCM(keyHex, plaintext) {
  const key = Buffer.from(keyHex, 'hex');
  const nonceInput = Buffer.concat([key, Buffer.from(plaintext)]);
  const nonceHash = crypto.createHash('sha256').update(nonceInput).digest();
  const nonce = nonceHash.subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString('hex');
}

// [PAPER-11] ElGamal 암호화용 BigInt 헬퍼
function bufToBigInt(buf) {
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function modPow(base, exp, mod) {
  base = ((base % mod) + mod) % mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function mutateTokenSignature(token) {
  const parts = token.split('.');
  const lastIdx = parts.length - 1; // HMAC: 2 parts, Ed25519: 3 parts
  const sigBuf = Buffer.from(parts[lastIdx], 'base64url');
  sigBuf[0] = sigBuf[0] ^ 0xff;
  parts[lastIdx] = sigBuf.toString('base64url');
  return parts.join('.');
}

function computeLocalRoot(leafHash, proofPath) {
  if (!proofPath || proofPath.length === 0) return leafHash;
  let current = leafHash;
  for (const step of proofPath) {
    if (step.position === 'right') {
      current = sha256Hex(current + step.hash);
    } else {
      current = sha256Hex(step.hash + current);
    }
  }
  return current;
}

async function main() {
  if (!ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN is required for election administration E2E');
  console.log('═══════════════════════════════════════════════════');
  console.log(' Full Election E2E Integration Test');
  console.log('═══════════════════════════════════════════════════');
  console.log(`[INFO] baseUrl=${BASE_URL}`);
  console.log(`[INFO] electionID=${ELECTION_ID}`);
  console.log(`[INFO] candidates=${CANDIDATES.join(', ')}`);
  console.log('');

  // ── Phase 1: 환경 확인 ──────────────────────────────────────
  console.log('── Phase 1: Environment Check ──');
  await assertOk('API root reachable', requestJson('/'));
  const health = await assertOk('health check', requestJson('/health'));
  console.log(`[INFO] credential mode: ${health.idemix?.impl || 'unknown'}`);

  // ── Phase 2: 선거 생성 + 활성화 ─────────────────────────────
  console.log('\n── Phase 2: Election Setup ──');
  const now = Math.floor(Date.now() / 1000);
  await assertOk('create election', requestJson('/api/elections', {
    method: 'POST',
    body: JSON.stringify({
      electionID: ELECTION_ID,
      title: `Full E2E ${ELECTION_ID}`,
      description: 'Generated by full-election-e2e.js',
      candidates: CANDIDATES,
      startTime: now - 10,
      endTime: now + 3600,
    }),
  }));
  await assertOk('activate election', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/activate`, {
    method: 'POST', body: '{}',
  }));

  // ── Phase 3: Credential 발급 (3명) ──────────────────────────
  console.log('\n── Phase 3: Credential Issuance ──');
  const voters = [
    { id: 'voter1', secret: 'voter1pw', candidate: 'CANDIDATE_A' },
    { id: 'voter2', secret: 'voter2pw', candidate: 'CANDIDATE_B' },
    { id: 'voter3', secret: 'voter3pw', candidate: 'CANDIDATE_A' },
  ];

  const credentials = [];
  const credentialMaterials = [];
  for (const v of voters) {
    const cred = await assertOk(`issue credential (${v.id})`, requestJson('/api/credential/idemix', {
      method: 'POST',
      body: JSON.stringify({ enrollmentID: v.id, enrollmentSecret: v.secret, electionID: ELECTION_ID }),
    }));
    credentials.push(cred.credential);
    credentialMaterials.push(cred.nullifierMaterial);
  }

  // ── Phase 4: Credential 검증 (실패 조건) ────────────────────
  console.log('\n── Phase 4: Credential Failure Tests ──');
  const bf = await assertOk('fetch blinding factor', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/blinding-factor`));

  const makeNullifier = (material) => sha256Hex(material + ELECTION_ID + bf.blindingFactor);
  const arbitraryNullifier = (suffix) => sha256Hex(`unbound:${suffix}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`);

  const isBypass = health.idemix?.mode === 'bypass';
  if (isBypass) {
    console.log('[SKIP] Credential failure tests skipped in bypass mode');
  } else {
    // 변조 credential 거부
    await assertRejected('tampered credential', requestJson('/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': mutateTokenSignature(credentials[0]) },
      body: JSON.stringify({ electionID: ELECTION_ID, candidateID: 'CANDIDATE_A', nullifierHash: arbitraryNullifier('tampered') }),
    }));

    // credential 누락 거부
    await assertRejected('missing credential', requestJson('/api/vote', {
      method: 'POST',
      body: JSON.stringify({ electionID: ELECTION_ID, candidateID: 'CANDIDATE_A', nullifierHash: arbitraryNullifier('nocred') }),
    }));

    // 유효한 credential을 그대로 쓰고 nullifier만 바꾸는 다중투표 우회를
    // API가 아닌 chaincode가 거부해야 한다.
    await assertRejected('valid credential with arbitrary nullifier', requestJson('/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': credentials[0] },
      body: JSON.stringify({ electionID: ELECTION_ID, candidateID: 'CANDIDATE_A', nullifierHash: arbitraryNullifier('credential-reuse') }),
    }));
  }

  // ── Phase 5: 투표 제출 (3명 레거시 + 1명 blind) ─────────────
  console.log('\n── Phase 5: Vote Submission ──');
  const nullifiers = [];
  const deniableReceipt = crypto.randomBytes(32).toString('hex');
  const normalPW = 'normal-password-test';
  const panicPW = 'panic-password-test';
  const normalLookupToken = deriveLookupToken(normalPW, deniableReceipt, ELECTION_ID);
  const panicLookupToken = deriveLookupToken(panicPW, deniableReceipt, ELECTION_ID);
  for (let i = 0; i < voters.length; i++) {
    const nh = makeNullifier(credentialMaterials[i]);
    const deniable = i === 0 ? { normalLookupToken, panicLookupToken, panicCandidateID: 'CANDIDATE_B' } : {};
    await assertOk(`vote (${voters[i].id} -> ${voters[i].candidate})`, requestJson('/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': credentials[i] },
      body: JSON.stringify({ electionID: ELECTION_ID, candidateID: voters[i].candidate, nullifierHash: nh, ...deniable }),
    }));
    nullifiers.push(nh);
  }

  if (health.demo?.endpointsEnabled === true) {
    console.log('\n-- Phase 5a: Authenticated Demo Dashboard Event --');
    await assertOk('committed voter emits verification event', requestJson('/api/vote/demo-event', {
      method: 'POST',
      headers: { 'x-idemix-credential': credentials[0] },
      body: JSON.stringify({ electionID: ELECTION_ID, nullifierHash: nullifiers[0] }),
    }));
    const events = await assertOk('dashboard receives verification event',
      requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/demo-events?since=0`));
    const verification = events.events?.find((event) => event.type === 'verify');
    if (!verification || verification.payload?.code !== nullifiers[0]) {
      throw new Error('dashboard verification event is missing or not bound to the committed nullifier');
    }
    await assertRejected('different credential cannot emit event for another voter',
      requestJson('/api/vote/demo-event', {
        method: 'POST', headers: { 'x-idemix-credential': credentials[1] },
        body: JSON.stringify({ electionID: ELECTION_ID, nullifierHash: nullifiers[0] }),
      }));
    await assertRejected('uncommitted nullifier cannot emit verification event',
      requestJson('/api/vote/demo-event', {
        method: 'POST', headers: { 'x-idemix-credential': credentials[0] },
        body: JSON.stringify({ electionID: ELECTION_ID, nullifierHash: arbitraryNullifier('demo-event') }),
      }));
    await assertRejected('legacy arbitrary dashboard event endpoint is unavailable',
      requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/demo-event`, {
        method: 'POST', body: JSON.stringify({ type: 'verify', payload: { code: nullifiers[0] } }),
      }));
  }

  // 동일 유권자/선거 credential을 재발급해도 material과 nullifier가 같고,
  // 새 표가 아니라 Last-Vote-Wins 재투표로 처리되어야 한다.
  const reissued = await assertOk('reissue credential (voter1)', requestJson('/api/credential/idemix', {
    method: 'POST',
    body: JSON.stringify({ enrollmentID: voters[0].id, enrollmentSecret: voters[0].secret, electionID: ELECTION_ID }),
  }));
  if (reissued.nullifierMaterial !== credentialMaterials[0]) {
    throw new Error('credential reissuance changed election nullifier material');
  }
  const revote = await assertOk('reissued credential maps to revote', requestJson('/api/vote', {
    method: 'POST',
    headers: { 'x-idemix-credential': reissued.credential },
    body: JSON.stringify({ electionID: ELECTION_ID, candidateID: voters[0].candidate, nullifierHash: nullifiers[0] }),
  }));
  if (!revote.isRevote || revote.evictCount < 1) {
    throw new Error(`reissued credential created a new vote instead of a revote: ${JSON.stringify(revote)}`);
  }

  // [PAPER-1] blind mode: voter4가 클라이언트-사이드 암호화로 투표
  console.log('\n── Phase 5b: Blind Mode Vote (PAPER-1) ──');
  const blindVoter = { id: 'voter4', secret: 'voter4pw', candidate: 'CANDIDATE_C' };
  const blindCred = await assertOk('issue credential (voter4 blind)', requestJson('/api/credential/idemix', {
    method: 'POST',
    body: JSON.stringify({ enrollmentID: blindVoter.id, enrollmentSecret: blindVoter.secret, electionID: ELECTION_ID }),
  }));
  // 암호화 키 조회
  const ekResp = await assertOk('fetch encryption key', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/encryption-key`));
  console.log(`[INFO] encryption key: ${ekResp.encryptionKeyHex.substring(0, 16)}...`);
  // 클라이언트-사이드 AES-GCM 암호화
  const encCandID = encryptAESGCM(ekResp.encryptionKeyHex, blindVoter.candidate);
  console.log(`[INFO] encrypted candidateID: ${encCandID.substring(0, 32)}...`);
  const blindNH = makeNullifier(blindCred.nullifierMaterial);
  const blindResult = await assertOk(`vote blind (${blindVoter.id} -> ${blindVoter.candidate})`, requestJson('/api/vote', {
    method: 'POST',
    headers: { 'x-idemix-credential': blindCred.credential },
    body: JSON.stringify({
      electionID: ELECTION_ID,
      nullifierHash: blindNH,
      encryptedCandidateID: encCandID,
    }),
  }));
  console.log(`[INFO] blind mode result: blindMode=${blindResult.blindMode}, candidateID=${blindResult.candidateID}`);
  nullifiers.push(blindNH);

  // [PAPER-3] Benaloh Challenge: prepare → audit → verify
  console.log('\n── Phase 5c: Benaloh Challenge (PAPER-3) ──');
  const prepResult = await assertOk('prepare ballot (Benaloh)', requestJson('/api/vote/prepare', {
    method: 'POST',
    headers: { 'x-idemix-credential': credentials[0] },
    body: JSON.stringify({ electionID: ELECTION_ID, candidateID: 'CANDIDATE_B' }),
  }));
  console.log(`[INFO] ballot prepared: ballotID=${prepResult.ballotID.substring(0, 16)}..., commitment=${prepResult.commitment.substring(0, 16)}...`);

  // audit (spoil) — 암호화 키와 평문 공개
  const auditResult = await assertOk('audit ballot (Benaloh spoil)', requestJson('/api/vote/audit', {
    method: 'POST',
    headers: { 'x-idemix-credential': credentials[0] },
    body: JSON.stringify({ electionID: ELECTION_ID, ballotID: prepResult.ballotID }),
  }));
  console.log(`[INFO] audit result: candidateID=${auditResult.candidateID}, status=${auditResult.status}`);

  // 독립 검증: 공개된 키로 재암호화하여 암호문 일치 확인
  const reEncrypted = encryptAESGCM(auditResult.encryptionKeyHex, auditResult.candidateID);
  const benalohVerified = reEncrypted === auditResult.encryptedCandidateID;
  console.log(`[${benalohVerified ? 'OK' : 'FAIL'}] Benaloh re-encryption match: ${benalohVerified}`);

  // audit된 ballot 재사용 확인 (체인코드 구현에 따라 거부 또는 동일 결과 반환)
  const reAudit = await requestJson('/api/vote/audit', {
    method: 'POST',
    headers: { 'x-idemix-credential': credentials[0] },
    body: JSON.stringify({ electionID: ELECTION_ID, ballotID: prepResult.ballotID }),
  });
  if (!reAudit.ok) {
    console.log('[OK] Duplicate audit correctly rejected');
  } else {
    console.log('[INFO] Re-audit returned same result (idempotent — acceptable)');
  }

  // ── Phase 6: 공개 Nullifier에 후보자 평문 없음 확인 ─────────
  console.log('\n── Phase 6: Privacy + Credential Verification ──');
  const allVoterLabels = [...voters.map(v => v.id), blindVoter.id];
  for (let i = 0; i < nullifiers.length; i++) {
    const label = allVoterLabels[i] || `voter${i}`;
    const nr = await assertOk(`get nullifier (${label})`, requestJson(`/api/nullifier/${nullifiers[i]}`));
    if (nr.candidateID && nr.candidateID !== '') {
      throw new Error(`privacy violation: nullifier for ${label} exposes candidateID ${nr.candidateID}`);
    } else {
      console.log(`[OK] nullifier for ${label} has no plaintext candidateID`);
    }
    // [PAPER-4] credential 검증 수준 확인
    if (!nr.credVerifyLevel || !nr.credVerifyLevel.startsWith('chaincode-')) {
      throw new Error(`${label} credential was not independently verified by chaincode: ${nr.credVerifyLevel || 'missing'}`);
    }
    console.log(`[OK] ${label} credVerifyLevel: ${nr.credVerifyLevel}`);
  }

  // ── Phase 7: 선거 종료 + 집계 ──────────────────────────────
  console.log('\n── Phase 7: Election Close + Tally ──');
  await assertOk('close election', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/close`, {
    method: 'POST', body: '{}',
  }));
  const tally = await assertOk('get tally', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/tally`));
  console.log(`[INFO] tally: ${JSON.stringify(tally.results)}, total=${tally.totalVotes}`);

  // Expected: A>=2, B>=1 (+ dummies)
  if (!tally.results['CANDIDATE_A'] || tally.results['CANDIDATE_A'] < 2) {
    throw new Error(`CANDIDATE_A expected >= 2, got ${tally.results['CANDIDATE_A']}`);
  }
  if (!tally.results['CANDIDATE_B'] || tally.results['CANDIDATE_B'] < 1) {
    throw new Error(`CANDIDATE_B expected >= 1, got ${tally.results['CANDIDATE_B']}`);
  }
  if (tally.totalVotes < voters.length) {
    throw new Error(`Total votes expected >= ${voters.length}, got ${tally.totalVotes}`);
  }
  console.log(`[OK] tally results valid (${tally.totalVotes - voters.length - 1} dummy votes included)`);

  // [PAPER-2] 집계 정확성 독립 검증
  if (tally.tallyProofHash && tally.decryptionProofs) {
    console.log(`[INFO] tallyProofHash: ${tally.tallyProofHash.substring(0, 32)}...`);
    console.log(`[INFO] decryptionProofs: ${tally.decryptionProofs.length} entries`);

    const verifyResult = await assertOk('verify tally (PAPER-2)', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/verify-tally`, {
      method: 'POST',
      body: JSON.stringify({ encryptionKeyHex: ekResp.encryptionKeyHex }),
    }));
    console.log(`[INFO] tally verification: verified=${verifyResult.verified}, valid=${verifyResult.validProofs}/${verifyResult.totalProofs}, tallyMatch=${verifyResult.tallyMatch}, proofHashMatch=${verifyResult.proofHashMatch}`);
    if (!verifyResult.verified) {
      throw new Error(`tally verification failed: ${JSON.stringify(verifyResult)}`);
    }
  } else {
    throw new Error('tally has no decryption proofs');
  }

  // ── Phase 8: Merkle Tree + Proof 검증 ──────────────────────
  console.log('\n── Phase 8: Merkle Proof Verification ──');
  const merkleResult = await assertOk('build merkle tree', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/merkle`, {
    method: 'POST', body: '{}',
  }));
  console.log(`[INFO] merkle root: ${merkleResult.rootHash}, leaves: ${merkleResult.leafCount}`);

  const merkleRoot = await assertOk('get merkle root', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/merkle`));
  const chainRoot = merkleRoot.rootHash;

  const allVoterIds = [...voters.map(v => v.id), blindVoter.id];
  for (let i = 0; i < nullifiers.length; i++) {
    const label = allVoterIds[i] || `voter${i}`;
    const proofResp = await assertOk(`get proof (${label})`, requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/proof/${nullifiers[i]}`));
    if (!proofResp.leafHash) throw new Error(`proof for ${label} has no leafHash`);
    if (!proofResp.candidateCommitment) throw new Error(`proof for ${label} has no candidateCommitment`);

    const computedRoot = computeLocalRoot(proofResp.leafHash, proofResp.proof);
    if (computedRoot === chainRoot) {
      console.log(`[OK] merkle proof verified (${label}): root match`);
    } else {
      throw new Error(`Merkle root mismatch for ${label}: computed=${computedRoot}, chain=${chainRoot}`);
    }
  }

  // 변조 검출
  const fakeRoot = computeLocalRoot(sha256Hex('tampered-data'), (await requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/proof/${nullifiers[0]}`)).body.proof);
  if (fakeRoot !== chainRoot) {
    console.log('[OK] tampered leafHash produces different root');
  } else {
    throw new Error('Tampered leafHash should NOT match chain root');
  }

  // ── Phase 9: Shamir SSS 키 분산 + 복원 ─────────────────────
  console.log('\n── Phase 9: Shamir Secret Sharing ──');
  await assertOk('init key sharing', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/keysharing`, {
    method: 'POST', body: '{}',
  }));

  // share 1, 2 제출 (2-of-3 threshold)
  for (const idx of ['1', '2']) {
    const shareResp = await assertOk(`get share ${idx}`, requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/shares/${idx}`));
    const submitResult = await assertOk(`submit share ${idx}`, requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/shares`, {
      method: 'POST',
      body: JSON.stringify({ shareIndex: idx, shareHex: shareResp.shareHex }),
    }));
    console.log(`[INFO] share ${idx} submitted, restored=${submitResult.restored || false}`);
  }

  const decStatus = await assertOk('decryption status', requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/decryption`));
  if (decStatus.isDecrypted !== true) {
    throw new Error('Shamir key restoration expected after 2-of-3 shares');
  }
  console.log('[OK] Shamir 2-of-3 key restoration verified');

  // ── Phase 10: Panic Password Deniable Proof ───────────────
  console.log('\n── Phase 10: Deniable Verification (Panic Mode) ──');
  // Normal password로 proof 조회
  const normalProofRaw = await requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/proof`, {
    method: 'POST',
    body: JSON.stringify({ lookupToken: normalLookupToken }),
  });
  const normalProofResp = await assertOk('deniable proof (normal)', Promise.resolve(normalProofRaw));
  console.log(`[INFO] normal proof returned (has proof: ${!!normalProofResp.proof})`);

  // Panic password로 proof 조회 — 다른 proof가 반환되어야 함
  const panicProofRaw = await requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/proof`, {
    method: 'POST',
    body: JSON.stringify({ lookupToken: panicLookupToken }),
  });
  const panicProofResp = await assertOk('deniable proof (panic)', Promise.resolve(panicProofRaw));
  console.log(`[INFO] panic proof returned (has proof: ${!!panicProofResp.proof})`);

  // 두 응답 모두 동일한 구조를 가져야 함 (강압자 구분 불가)
  const normalKeys = Object.keys(normalProofResp).sort().join(',');
  const panicKeys = Object.keys(panicProofResp).sort().join(',');
  if (normalKeys !== panicKeys) {
    throw new Error(`normal/panic response structure differs: normal=${normalKeys}, panic=${panicKeys}`);
  }
  if (normalProofRaw.bodyBytes !== RESPONSE_BYTES || panicProofRaw.bodyBytes !== RESPONSE_BYTES) {
    throw new Error(`deniable response size mismatch: normal=${normalProofRaw.bodyBytes}, panic=${panicProofRaw.bodyBytes}`);
  }
  if (JSON.stringify(normalProofResp).includes(nullifiers[0]) || JSON.stringify(panicProofResp).includes(nullifiers[0])) {
    throw new Error('deniable response exposed the real public nullifier');
  }
  if (normalProofResp.proof?.leafHash === panicProofResp.proof?.leafHash) {
    throw new Error('normal and panic lookup unexpectedly resolved to the same proof target');
  }
  console.log(`[OK] opaque proofs omit target nullifier and are exactly ${RESPONSE_BYTES} bytes`);

  // ── Phase 11: Security Properties (PAPER-5) ─────────────────
  console.log('\n── Phase 11: Security Properties ──');
  const secProps = await assertOk('security properties', requestJson('/api/elections/security-properties'));
  if (secProps.evidenceClass !== 'self-declared-capabilities' || secProps.independentlyVerified !== false) {
    throw new Error('security-properties endpoint must identify itself as non-independent metadata');
  }
  const declared = secProps.properties;
  const declaredImplemented = [
    declared.ballotSecrecy,
    declared.castAsIntended,
    declared.recordedAsCast,
    declared.talliedAsRecorded,
    declared.eligibilityVerify,
  ].filter(p => p.status === 'implemented').length;
  const declaredUnverified = declared.coercionResistance.status === 'unverified' ? 1 : 0;
  console.log(`[INFO] Self-declared capability metadata only: ${declaredImplemented} implemented labels, ${declaredUnverified} unverified label`);
  console.log('[INFO] This phase is not independent evidence for any of the seven security properties.');
  console.log(`[INFO] Crypto: ${declared.cryptoPrimitives.join(', ')}`);
  console.log(`[INFO] Endorsement: ${declared.endorsementPolicy}`);

  // ── Phase 12: Universal Verifiability (PAPER-6) ────────────
  console.log('\n── Phase 12: Universal Verifiability ──');

  // 12a. 감사 데이터 공개 게시
  const publishResult = await assertOk('publish audit data',
    requestJson(`/api/elections/${ELECTION_ID}/publish-audit`, { method: 'POST' })
  );
  console.log(`[INFO] Bulletin Board published: ${publishResult.ballotsPublished} ballots, key=${publishResult.keyPublished}`);

  // 12b. Bulletin Board 조회
  const bulletinBoard = await assertOk('get bulletin board',
    requestJson(`/api/elections/${ELECTION_ID}/bulletin-board`)
  );
  console.log(`[INFO] Bulletin Board: ${bulletinBoard.encryptedBallots.length} ballots, key published=${!!bulletinBoard.encryptionKeyHex}`);
  // [PAPER-7] 셔플 확인
  console.log(`[INFO] Shuffle: seed=${bulletinBoard.shuffleSeed ? 'present' : 'none'}, proofHash=${bulletinBoard.shuffleProofHash ? 'present' : 'none'}`);

  // 12c. 공개 독립 검증 (키 입력 불필요)
  const publicVerify = await assertOk('public tally verification',
    requestJson(`/api/elections/${ELECTION_ID}/verify-public`, { method: 'POST' })
  );
  console.log(`[INFO] Public verification: valid=${publicVerify.isValid}, verified=${publicVerify.decryptionVerified}/${publicVerify.totalBallots}`);
  console.log(`[INFO]   Results match: ${publicVerify.resultsMatch}, Proof hash match: ${publicVerify.proofHashMatch}, Shuffle verified: ${publicVerify.shuffleVerified}`);
  if (publicVerify.isValid !== true || publicVerify.resultsMatch !== true ||
      publicVerify.proofHashMatch !== true || publicVerify.shuffleVerified !== true ||
      publicVerify.decryptionFailed !== 0 || publicVerify.totalBallots !== tally.totalVotes) {
    throw new Error(`public tally verification failed: ${JSON.stringify(publicVerify)}`);
  }

  // 12d. 중복 게시 방지 확인
  const dupPublish = await requestJson(`/api/elections/${ELECTION_ID}/publish-audit`, { method: 'POST' });
  if (!dupPublish.ok) {
    console.log('[OK] Duplicate publish correctly rejected');
  }

  const universalVerified = publicVerify.isValid;

  // ── Phase 13: Receipt-Free Verification (PAPER-8) ─────────
  console.log('\n── Phase 13: Receipt-Free Verification ──');

  // 13a. 실제 투표의 receipt-free 확인 (증명 데이터 없이 포함 여부만)
  const voteCounted = await assertOk('receipt-free vote check',
    requestJson(`/api/elections/${ELECTION_ID}/vote-counted/${nullifiers[0]}`)
  );
  console.log(`[INFO] Vote counted: included=${voteCounted.included}, totalVotes=${voteCounted.totalVotes}`);
  if (!voteCounted.included) throw new Error('Receipt-free check failed: vote not included');

  // 13b. 존재하지 않는 nullifier 확인
  const fakeNullifier = sha256Hex('nonexistent-voter-secret' + ELECTION_ID + 'fake-blinding');
  const fakeCheck = await assertOk('receipt-free fake nullifier',
    requestJson(`/api/elections/${ELECTION_ID}/vote-counted/${fakeNullifier}`)
  );
  console.log(`[INFO] Fake nullifier: included=${fakeCheck.included}`);
  if (fakeCheck.included) throw new Error('Receipt-free check failed: fake nullifier was included');

  const receiptFreeOk = voteCounted.included && !fakeCheck.included;

  // ── Phase 14: ElGamal Full Pipeline (PAPER-11) ─────────
  console.log('\n── Phase 14: ElGamal Full Pipeline ──');

  const EG_ELECTION_ID = `elgamal-e2e-${Date.now()}`;
  const EG_CANDIDATES = ['ALICE', 'BOB'];
  const egEndTime = Math.floor(Date.now() / 1000) + 3600;
  const egStartTime = Math.floor(Date.now() / 1000) - 60;

  // 14a. ElGamal 모드 선거 생성
  await assertOk('create ElGamal election',
    requestJson('/api/elections', {
      method: 'POST',
      body: JSON.stringify({
        electionID: EG_ELECTION_ID,
        title: 'ElGamal E2E Test',
        description: 'Chaum-Pedersen ZKP test',
        candidates: EG_CANDIDATES,
        startTime: egStartTime,
        endTime: egEndTime,
        encryptionMode: 'elgamal-vector-v3',
      }),
    })
  );

  // 14b. 선거 활성화
  await assertOk('activate ElGamal election',
    requestJson(`/api/elections/${EG_ELECTION_ID}/activate`, { method: 'POST' })
  );

  // 14c. 선거 정보 확인 (encryptionMode == elgamal)
  const egElection = await assertOk('get ElGamal election',
    requestJson(`/api/elections/${EG_ELECTION_ID}`)
  );
  console.log(`[INFO] ElGamal election mode: ${egElection.encryptionMode}`);
  if (egElection.encryptionMode !== 'elgamal-vector-v3') throw new Error('Election mode is not elgamal-vector-v3');

  // 14d. ElGamal 공개키 조회
  const egPubKey = await assertOk('get ElGamal public key',
    requestJson(`/api/elections/${EG_ELECTION_ID}/elgamal-pubkey`)
  );
  console.log(`[INFO] ElGamal pubKey.Y: ${egPubKey.pubKey.y.substring(0, 32)}...`);

  // 14e. Exponential ElGamal 암호화 + Ballot Validity ZKP (PAPER-13)
  const egBf = await assertOk('get ElGamal blinding factor',
    requestJson(`/api/elections/${EG_ELECTION_ID}/blinding-factor`)
  );
  const HOMO_BASE = 10000n;
  const p = BigInt('0x' + egPubKey.pubKey.p);
  const g = BigInt('0x' + egPubKey.pubKey.g);
  const y = BigInt('0x' + egPubKey.pubKey.y);
  const q = (p - 1n) / 2n;

  // modInverse 헬퍼
  function modInverse(a, m) {
    a = ((a % m) + m) % m;
    let [old_r, r2] = [a, m];
    let [old_s, s2] = [1n, 0n];
    while (r2 !== 0n) {
      const qq = old_r / r2;
      [old_r, r2] = [r2, old_r - qq * r2];
      [old_s, s2] = [s2, old_s - qq * s2];
    }
    if (old_r !== 1n) return null;
    return ((old_s % m) + m) % m;
  }

  // 동기 SHA-256 → BigInt
  function sha256ToBigInt(input) {
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    return BigInt('0x' + hash);
  }

  // Exponential ElGamal 암호화 + Disjunctive Chaum-Pedersen ZKP 생성
  function expElGamalEncryptWithZKP(candidateIndex, numCandidates) {
    const mVal = HOMO_BASE ** BigInt(candidateIndex);
    const gm = modPow(g, mVal, p); // g^(B^i) mod p

    const rBytes2 = crypto.randomBytes(32);
    let r2 = bufToBigInt(rBytes2) % (p - 2n);
    if (r2 === 0n) r2 = 1n;

    const c1val = modPow(g, r2, p);
    const c2val = (gm * modPow(y, r2, p)) % p;
    const c1Hex = c1val.toString(16);
    const c2Hex = c2val.toString(16);

    // Disjunctive Chaum-Pedersen ZKP
    const a1s = new Array(numCandidates);
    const a2s = new Array(numCandidates);
    const es = new Array(numCandidates);
    const zs = new Array(numCandidates);

    const kBytes = crypto.randomBytes(32);
    let k = bufToBigInt(kBytes) % q;
    if (k === 0n) k = 1n;

    let eSum = 0n;
    for (let j = 0; j < numCandidates; j++) {
      if (j === candidateIndex) continue;
      const mj = modPow(g, HOMO_BASE ** BigInt(j), p);
      const mjInv = modInverse(mj, p);
      const c2DivMj = (c2val * mjInv) % p;

      const ej = bufToBigInt(crypto.randomBytes(32)) % q;
      const zj = bufToBigInt(crypto.randomBytes(32)) % q;

      const gzj = modPow(g, zj, p);
      const c1InvEj = modPow(modInverse(c1val, p), ej, p);
      a1s[j] = ((gzj * c1InvEj) % p).toString(16);

      const yzj = modPow(y, zj, p);
      const c2DivMjInvEj = modPow(modInverse(c2DivMj, p), ej, p);
      a2s[j] = ((yzj * c2DivMjInvEj) % p).toString(16);

      es[j] = ej.toString(16);
      zs[j] = zj.toString(16);
      eSum = (eSum + ej) % q;
    }

    a1s[candidateIndex] = modPow(g, k, p).toString(16);
    a2s[candidateIndex] = modPow(y, k, p).toString(16);

    let hashInput = c1Hex + '|' + c2Hex;
    for (let j = 0; j < numCandidates; j++) {
      hashInput += '|' + a1s[j] + '|' + a2s[j];
    }
    const eTotal = sha256ToBigInt(hashInput) % q;
    const eActual = ((eTotal - eSum) % q + q) % q;
    es[candidateIndex] = eActual.toString(16);
    const zActual = (k + eActual * r2) % q;
    zs[candidateIndex] = zActual.toString(16);

    return {
      encrypted: `${c1Hex}:${c2Hex}`,
      proof: { a1s, a2s, es, zs },
    };
  }

  // 14e-1. ElGamal 투표용 credential 발급
  const egCredentials = [];
  const egCredentialMaterials = [];
  for (const v of voters.slice(0, 2)) {
    const cred = await assertOk(`issue ElGamal credential (${v.id})`, requestJson('/api/credential/idemix', {
      method: 'POST',
      body: JSON.stringify({ enrollmentID: v.id, enrollmentSecret: v.secret, electionID: EG_ELECTION_ID }),
    }));
    egCredentials.push(cred.credential);
    egCredentialMaterials.push(cred.nullifierMaterial);
  }

  const crossElectionBallot = generateVectorBallot(egPubKey.pubKey, 0, EG_CANDIDATES.length);
  await assertRejected('credential replay across elections', requestJson('/api/vote/prepare-vector', {
    method: 'POST',
    headers: { 'x-idemix-credential': credentials[0] },
    body: JSON.stringify({
      electionID: EG_ELECTION_ID,
      clientNonceHash: sha256Hex(crypto.randomBytes(32).toString('hex')),
      encryptedCandidateVector: crossElectionBallot.encryptedCandidateVector,
      nullifierHash: sha256Hex(`cross-election:${Date.now()}`),
      vectorBallotValidityProof: crossElectionBallot.vectorBallotValidityProof,
    }),
  }));

  // 투표 1: ALICE (index=0)
  const egNullifier1 = sha256Hex(egCredentialMaterials[0] + EG_ELECTION_ID + egBf.blindingFactor);
  const vote1 = generateVectorBallot(egPubKey.pubKey, 0, EG_CANDIDATES.length);

  await castPreparedVector('ElGamal vote (ALICE)', { 'x-idemix-credential': egCredentials[0] },
    EG_ELECTION_ID, egNullifier1, vote1);
  console.log('[INFO] Exponential ElGamal vote (ALICE) cast with ZKP');

  // 투표 2: BOB (index=1)
  const egNullifier2 = sha256Hex(egCredentialMaterials[1] + EG_ELECTION_ID + egBf.blindingFactor);
  const vote2 = generateVectorBallot(egPubKey.pubKey, 1, EG_CANDIDATES.length);

  await castPreparedVector('ElGamal vote (BOB)', { 'x-idemix-credential': egCredentials[1] },
    EG_ELECTION_ID, egNullifier2, vote2);
  console.log('[INFO] Exponential ElGamal vote (BOB) cast with ZKP');

  // 14f. 선거 종료 + 암호문 집계
  await assertOk('close ElGamal election',
    requestJson(`/api/elections/${EG_ELECTION_ID}/close`, { method: 'POST' })
  );

  const encryptedEgTally = await assertOk('get encrypted ElGamal tally',
    requestJson(`/api/elections/${EG_ELECTION_ID}/tally`)
  );
  if (encryptedEgTally.decrypted !== false) {
    throw new Error(`ElGamal tally must remain encrypted before threshold reconstruction: ${JSON.stringify(encryptedEgTally)}`);
  }
  if (encryptedEgTally.encAggVector?.length !== EG_CANDIDATES.length) {
    throw new Error('encrypted vector-v3 tally is missing candidate aggregate ciphertexts');
  }
  if (encryptedEgTally.decryptionProofs?.length) {
    throw new Error('decryption proofs must not exist before threshold reconstruction');
  }

  // 14g. 2-of-3 verifiable partial decryptions. Raw scalar shares must never
  // be returned by the API or published on the ledger.
  for (const idx of ['1', '2']) {
    await assertOk(`submit ElGamal partial decryption ${idx}`,
      requestJson(`/api/elections/${EG_ELECTION_ID}/partial-decryptions`, {
        method: 'POST',
        body: JSON.stringify({ shareIndex: idx }),
      })
    );
  }
  const egDecStatus = await assertOk('ElGamal decryption status',
    requestJson(`/api/elections/${EG_ELECTION_ID}/decryption`)
  );
  if (!egDecStatus.restored && !egDecStatus.isDecrypted) {
    throw new Error(`ElGamal threshold partial decryption did not complete: ${JSON.stringify(egDecStatus)}`);
  }
  if (egDecStatus.mode !== 'partial-decryption-v2') {
    throw new Error(`ElGamal must use partial-decryption-v2, got: ${JSON.stringify(egDecStatus)}`);
  }

  // 14h. 복원 후 동형 집계 결과 검증
  const egTally = await assertOk('get ElGamal tally',
    requestJson(`/api/elections/${EG_ELECTION_ID}/tally`)
  );
  console.log(`[INFO] Homomorphic tally: ${JSON.stringify(egTally.results)}`);

  // 동형 집계 결과 검증: ALICE=1, BOB=1
  const homoTallyOk = egTally.results?.['ALICE'] === 1 && egTally.results?.['BOB'] === 1;
  console.log(`[INFO] Homomorphic tally verification: ${homoTallyOk ? 'PASS' : 'FAIL'}`);
  if (!homoTallyOk) {
    throw new Error(`homomorphic tally expected exactly {ALICE:1,BOB:1}, got ${JSON.stringify(egTally.results)}`);
  }

  if (egTally.decrypted !== true) {
    throw new Error(`ElGamal tally must be marked decrypted after threshold reconstruction: ${JSON.stringify(egTally)}`);
  }
  if (egTally.vectorPartialDecryptions?.length !== 2 || egTally.vectorPartialDecryptions.some((p) => p.values?.length !== EG_CANDIDATES.length || p.proofs?.length !== EG_CANDIDATES.length || p.shareHex)) {
    throw new Error(`expected exactly two proof-carrying vector partial decryptions and no raw shares: ${JSON.stringify(egTally.vectorPartialDecryptions)}`);
  }

  // 14i. ZKP 검증 (동형 집계 증명)
  const egZkp = await assertOk('verify ElGamal ZKP',
    requestJson(`/api/elections/${EG_ELECTION_ID}/verify-elgamal`, { method: 'POST' })
  );
  console.log(`[INFO] Homomorphic tally ZKP: valid=${egZkp.isValid}, proofs=${egZkp.totalProofs}`);
  if (!Number.isInteger(egZkp.totalProofs) || egZkp.totalProofs < 1) {
    throw new Error(`ElGamal verification returned no proofs: ${JSON.stringify(egZkp)}`);
  }
  if (!egZkp.isValid) {
    throw new Error(`ElGamal proof verification failed: ${JSON.stringify(egZkp)}`);
  }
  const elgamalZkpOk = true;

  await assertOk('publish ElGamal threshold audit data',
    requestJson(`/api/elections/${EG_ELECTION_ID}/publish-audit`, { method: 'POST' })
  );
  const egBoard = await assertOk('get ElGamal threshold bulletin board',
    requestJson(`/api/elections/${EG_ELECTION_ID}/bulletin-board`)
  );
	if (egBoard.vectorPartialDecryptions?.length !== 2 || egBoard.thresholdPublicShares?.length !== 3 ||
		JSON.stringify(egBoard.encAggVector) !== JSON.stringify(egTally.encAggVector)) {
    throw new Error(`ElGamal bulletin board lacks threshold verification material: ${JSON.stringify(egBoard)}`);
  }

  // ── Phase 15: panic-filtering behavior (not full coercion resistance) ──
  console.log('\n── Phase 15: Panic-Filtering Behavior (Limited) ──');

  const CR_ELECTION_ID = `coercion-e2e-${Date.now()}`;
  const CR_CANDIDATES = ['HONEST', 'COERCED'];
  const crEndTime = Math.floor(Date.now() / 1000) + 3600;
  const crStartTime = Math.floor(Date.now() / 1000) - 60;

  // 15a. 선거 생성
  await assertOk('create coercion-test election',
    requestJson('/api/elections', {
      method: 'POST',
      body: JSON.stringify({
        electionID: CR_ELECTION_ID,
        title: 'Panic Filtering Behavior E2E Test',
        description: 'Limited PDC panic-filtering behavior test; not a coercion-resistance proof',
        candidates: CR_CANDIDATES,
        startTime: crStartTime,
        endTime: crEndTime,
      }),
    })
  );

  // 15b. 선거 활성화
  await assertOk('activate coercion-test election',
    requestJson(`/api/elections/${CR_ELECTION_ID}/activate`, { method: 'POST' })
  );

  // 15c. 블라인딩 팩터 조회
  const crBf = await assertOk('get coercion blinding factor',
    requestJson(`/api/elections/${CR_ELECTION_ID}/blinding-factor`)
  );

  // 15c-1. Coercion 테스트용 credential 발급
  const crCredentials = [];
  const crCredentialMaterials = [];
  for (const v of voters) {
    const cred = await assertOk(`issue coercion credential (${v.id})`, requestJson('/api/credential/idemix', {
      method: 'POST',
      body: JSON.stringify({ enrollmentID: v.id, enrollmentSecret: v.secret, electionID: CR_ELECTION_ID }),
    }));
    crCredentials.push(cred.credential);
    crCredentialMaterials.push(cred.nullifierMaterial);
  }

  // 15d. 정상 투표 (real credential)
  const crRealNullifier = sha256Hex(crCredentialMaterials[0] + CR_ELECTION_ID + crBf.blindingFactor);
  await assertOk('cast REAL vote (HONEST)',
    requestJson('/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': crCredentials[0] },
      body: JSON.stringify({
        electionID: CR_ELECTION_ID,
        candidateID: 'HONEST',
        nullifierHash: crRealNullifier,
      }),
    })
  );

  // 15e. 패닉 투표 (panic credential) — 강압 하에 제출
  const crPanicNullifier = sha256Hex(crCredentialMaterials[1] + CR_ELECTION_ID + crBf.blindingFactor);
  await assertOk('cast PANIC vote (COERCED)',
    requestJson('/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': crCredentials[1] },
      body: JSON.stringify({
        electionID: CR_ELECTION_ID,
        candidateID: 'COERCED',
        nullifierHash: crPanicNullifier,
        credentialType: 'panic',
      }),
    })
  );

  // 15f. 두 번째 정상 투표 (다른 유권자)
  const crReal2Nullifier = sha256Hex(crCredentialMaterials[2] + CR_ELECTION_ID + crBf.blindingFactor);
  await assertOk('cast REAL vote 2 (COERCED)',
    requestJson('/api/vote', {
      method: 'POST',
      headers: { 'x-idemix-credential': crCredentials[2] },
      body: JSON.stringify({
        electionID: CR_ELECTION_ID,
        candidateID: 'COERCED',
        nullifierHash: crReal2Nullifier,
      }),
    })
  );

  // 15g. 선거 종료 + 집계
  await assertOk('close coercion-test election',
    requestJson(`/api/elections/${CR_ELECTION_ID}/close`, { method: 'POST' })
  );
  const crTally = await assertOk('get coercion-test tally',
    requestJson(`/api/elections/${CR_ELECTION_ID}/tally`)
  );
  console.log(`[INFO] Coercion tally: ${JSON.stringify(crTally.results)}`);

  // 15h. 검증: 패닉 투표가 필터링되었는지 확인
  // 3표 투입 (real HONEST, panic COERCED, real COERCED)
  // 패닉 1표 필터링 → 유효 투표 2표 (+ 더미 nullifier)
  // HONEST=1, COERCED=1 (real만 집계)
  const crHonestVotes = crTally.results['HONEST'] || 0;
  const crCoercedVotes = crTally.results['COERCED'] || 0;
  // 패닉 투표(COERCED 1표)가 필터링되면 정확히 real 2표만 남아야 함.
  const panicFilterOk = crHonestVotes === 1 && crCoercedVotes === 1 && crTally.totalVotes === 2;
  console.log(`[INFO] Panic filter: HONEST=${crHonestVotes}, COERCED=${crCoercedVotes}, filtered=${panicFilterOk}`);
  if (!panicFilterOk) {
    throw new Error(`panic vote filtering failed: HONEST=${crHonestVotes}, COERCED=${crCoercedVotes}`);
  }

  // ── 최종 요약 ──────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Election:     ${ELECTION_ID}`);
  console.log(`  Voters:       ${voters.length} legacy + 1 blind (total=${tally.totalVotes})`);
  console.log(`  Tally:        ${JSON.stringify(tally.results)}`);
  console.log(`  Merkle Root:  ${chainRoot}`);
  console.log(`  Merkle Leaves:${merkleResult.leafCount}`);
  console.log(`  Shamir:       2-of-3 isDecrypted=${decStatus.isDecrypted}`);
  console.log(`  Deniable:     normal/panic proof tested`);
  console.log(`  Credential:   ${health.idemix?.impl || 'unknown'}`);
  console.log(`  Blind Mode:   voter4 -> ${blindVoter.candidate} (client-side encryption)`);
  console.log(`  Benaloh:      audit verified=${benalohVerified} (cast-as-intended)`);
  console.log(`  Universal:    public verify=${universalVerified} (PAPER-6)`);
  console.log(`  ReceiptFree:  ${receiptFreeOk} (PAPER-8)`);
  console.log('  Security:     self-declared metadata inspected (not a 7/7 verification)');
  console.log(`  ElGamal ZKP:  ${elgamalZkpOk} (Chaum-Pedersen, PAPER-11)`);
  console.log(`  Panic filter: ${panicFilterOk} (limited mechanism test; not coercion-resistance verification)`);
  console.log('═══════════════════════════════════════════════════');
  console.log('[DONE] Full Election E2E Integration Test completed (15 phases)');
}

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exit(1);
});
