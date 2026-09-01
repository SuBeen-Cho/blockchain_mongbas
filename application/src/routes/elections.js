/**
 * routes/elections.js — 선거 관련 REST API
 *
 * GET  /api/elections/:id          선거 정보 조회
 * POST /api/elections              선거 생성 (관리자)
 * POST /api/elections/:id/close    선거 종료 + 자동 집계 (관리자)
 * GET  /api/elections/:id/tally    개표 결과 조회
 * POST /api/elections/:id/verify-tally  집계 정확성 독립 검증 (키 필요)
 * POST /api/elections/:id/publish-audit 감사 데이터 공개 게시 (PAPER-6)
 * GET  /api/elections/:id/bulletin-board 공개 감사 데이터 조회 (PAPER-6)
 * POST /api/elections/:id/verify-public  공개 독립 검증 (PAPER-6, 키 불필요)
 * GET  /api/elections/:id/vote-counted/:nullifier  Receipt-free 투표 포함 확인 (PAPER-8)
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const { connectGateway, connectGatewayForShareIndex } = require('../gateway');
const liveCount = require('../lib/liveCount');  // [부스 시연] 라이브 투표 카운터
const demoLive  = require('../lib/demoLive');   // [부스 시연] 라이브 암호문 표 + 셔플 + 이벤트 버스

const router = express.Router();

// ── electionID 입력 검증 (CouchDB 인젝션 방지) ────────────────
const ELECTION_ID_RE = /^[A-Za-z0-9_.\-]+$/;
function validateElectionID(id) {
  if (!id || id.length > 256 || !ELECTION_ID_RE.test(id)) {
    return false;
  }
  return true;
}
function requireValidElectionID(req, res, next) {
  const id = req.params.id || req.body.electionID;
  if (id && !validateElectionID(id)) {
    return res.status(400).json({ error: 'electionID 형식이 올바르지 않습니다. (영문, 숫자, -, _, . 만 허용)' });
  }
  next();
}
router.use(requireValidElectionID);

// ── 체인코드 에러 메시지 살균 ─────────────────────────────────
function sanitizeError(err) {
  const msg = err.message || '';
  // 사용자에게 안전한 에러만 반환, 내부 상태 노출 방지
  if (msg.includes('존재하지 않')) return '해당 리소스를 찾을 수 없습니다.';
  if (msg.includes('권한'))       return '권한이 없습니다.';
  if (msg.includes('상태'))       return '현재 상태에서 수행할 수 없는 작업입니다.';
  if (msg.includes('이미'))       return '이미 처리된 요청입니다.';
  if (msg.includes('형식') || msg.includes('파싱')) return '입력 형식이 올바르지 않습니다.';
  return '요청을 처리할 수 없습니다.';
}

function hashWithLengthPrefix(...fields) {
  const h = crypto.createHash('sha256');
  for (const f of fields) {
    h.update(Buffer.from(f.length.toString(16).padStart(8, '0')));
    h.update(f);
  }
  return h.digest('hex');
}

function computeMerkleLeafHashFromNullifier(n) {
  if (!n) return '';
  if (!n.candidateCommitment || !n.encryptedCandidateID) {
    return crypto.createHash('sha256').update(n.nullifierHash || '').digest('hex');
  }
  return hashWithLengthPrefix(n.electionID, n.nullifierHash, n.candidateCommitment, n.encryptedCandidateID);
}

// ── GET /api/elections/:id/blinding-factor ─────────────────────
// [CRIT-03 FIX] 선거별 블라인딩 팩터 조회 (누구나)
// 유권자는 투표 전 반드시 호출하여 nullifier 계산에 사용합니다.
// nullifierHash = SHA256(voterSecret + electionID + blindingFactor)
router.get('/:id/blinding-factor', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetBlindingFactor', id);
    const blindingFactor = Buffer.from(result).toString('utf8').replace(/^"|"$/g, '');
    res.json({ electionID: id, blindingFactor });
  } catch (err) {
    res.status(404).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id/encryption-key ─────────────────────
// [PAPER-1] 클라이언트-사이드 암호화용 AES 키 조회
// ACTIVE 상태의 선거에서만 반환 (체인코드에서 상태 검증)
router.get('/:id/encryption-key', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetEncryptionKey', id);
    const encryptionKeyHex = Buffer.from(result).toString('utf8').replace(/^"|"$/g, '');
    res.json({ electionID: id, encryptionKeyHex });
  } catch (err) {
    console.error('[elections] GetEncryptionKey error:', err.message);
    res.status(400).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id/elgamal-pubkey ─────────────────────
// [PAPER-11] ElGamal 공개키 조회 (ElGamal 모드 선거에서만)
router.get('/:id/elgamal-pubkey', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetElGamalPublicKey', id);
    const pubKey = JSON.parse(Buffer.from(result).toString('utf8'));
    res.json({ electionID: id, pubKey });
  } catch (err) {
    console.error('[elections] GetElGamalPublicKey error:', err.message);
    res.status(400).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections/:id/verify-elgamal ────────────────────
// [PAPER-11] ElGamal Chaum-Pedersen ZKP 공개 검증
router.post('/:id/verify-elgamal', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('VerifyElGamalProofs', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    console.error('[elections] VerifyElGamalProofs error:', err.message);
    res.status(400).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/security-properties ───────────────────
// [PAPER-5] 시스템 보안 속성 요약 (감사 및 논문용)
// 주의: /:id 라우트보다 먼저 정의해야 함 (Express 라우팅 우선순위)
router.get('/security-properties', async (_req, res) => {
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetSecurityProperties');
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    console.error('[elections] GetSecurityProperties error:', err.message);
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id ─────────────────────────────────────
// 선거 정보 조회 (누구나)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetElection', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    console.error('[elections] GetElection error:', err.message);
    res.status(404).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections ────────────────────────────────────────
// 선거 생성 (관리자)
// Body: { electionID, title, description, candidates: [], startTime, endTime }
// startTime, endTime: Unix timestamp (초), startTime 생략 시 현재 시각 사용
router.post('/', async (req, res) => {
  const { electionID, title, description, candidates, startTime, endTime, encryptionMode } = req.body;

  if (!electionID || !title || !candidates || !Array.isArray(candidates) || !endTime) {
    return res.status(400).json({
      error: 'electionID, title, candidates(배열), endTime 필드가 필요합니다.',
    });
  }

  // 후보자 배열 검증
  if (candidates.some(c => typeof c !== 'string' || c.length === 0 || c.length > 256)) {
    return res.status(400).json({ error: '후보자 이름은 1~256자의 문자열이어야 합니다.' });
  }
  if (new Set(candidates).size !== candidates.length) {
    return res.status(400).json({ error: '중복된 후보자가 있습니다.' });
  }

  // [PAPER-11] 암호화 모드 검증
  const mode = encryptionMode || 'aes';
  if (!['aes', 'elgamal'].includes(mode)) {
    return res.status(400).json({ error: 'encryptionMode는 "aes" 또는 "elgamal"이어야 합니다.' });
  }

  const actualStartTime = startTime || Math.floor(Date.now() / 1000);

  const { gateway, contract } = await connectGateway();
  try {
    // [PAPER-11] encryptionMode를 transient data로 전달
    const args = [electionID, title, description || '', JSON.stringify(candidates), String(actualStartTime), String(endTime)];
    const proposalOpts = { arguments: args };
    if (mode === 'elgamal') {
      // [P2 보안] ElGamal 키를 공개 txID가 아닌 "비밀 seed"로 유도하도록 masterSeed를 transient로 전달.
      //   transient는 오더러/원장에 기록되지 않으므로 키가 공개 데이터로 재계산되지 않는다.
      //   서버는 seed를 저장/로깅하지 않고 즉시 폐기한다(trusted dealer 가정).
      proposalOpts.transientData = {
        encryptionMode: Buffer.from('elgamal'),
        masterSeed: crypto.randomBytes(32),
      };
    }
    const proposal = contract.newProposal('CreateElection', proposalOpts);
    const transaction = await proposal.endorse();
    const submitted = await transaction.submit();
    const status = await submitted.getStatus();
    if (!status.successful) {
      throw new Error(`CreateElection 트랜잭션 실패: ${status.code}`);
    }
    try { liveCount.reset(electionID); demoLive.reset(electionID); } catch (_) { /* 리셋 실패 무시 */ }
    res.status(201).json({ message: '선거가 생성되었습니다.', electionID, encryptionMode: mode });
  } catch (err) {
    console.error('[elections] CreateElection error:', err.message);
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id/live-count ──────────────────────────
// [부스 시연] 진행 중 선거의 실시간 투표 수 (백엔드 인메모리 카운터 — 관제판 폴링용)
router.get('/:id/live-count', (req, res) => {
  res.json({ electionID: req.params.id, totalVotes: liveCount.get(req.params.id) });
});

// ── GET /:id/live-votes ────────────────────────────────────────
// [부스 시연] 도착한 암호문 표를 실시간 제공 (대시보드가 폴링) — 새로고침 없이 누적/셔플 반영
router.get('/:id/live-votes', (req, res) => {
  res.json({ electionID: req.params.id, ...demoLive.listVotes(req.params.id) });
});

// ── POST /:id/demo-event ───────────────────────────────────────
// [부스 시연] 모바일 → 대시보드 이벤트 (예: 검증하기 누름). Body: { type, payload }
router.post('/:id/demo-event', (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type 필요' });
  demoLive.pushEvent(req.params.id, String(type), payload || {});
  res.json({ ok: true });
});

// ── GET /:id/demo-events?since=N ───────────────────────────────
// [부스 시연] 대시보드가 폴링해 모바일 액션을 감지 (검증 뷰 전환 등)
router.get('/:id/demo-events', (req, res) => {
  res.json({ electionID: req.params.id, ...demoLive.listEvents(req.params.id, req.query.since) });
});

// ── POST /api/elections/:id/seed-votes ─────────────────────────
// [부스 시연] 서버에서 ElGamal 투표 N개를 자동 주입 (게시판/집계 채우기).
// Body: { count: number, dist?: number[] }  dist 미지정 시 무작위 후보.
// 내부 HTTP로 자격증명 발급 + /api/vote 경로를 그대로 재사용한다(DISABLE_RATE_LIMITS 권장).
router.post('/:id/seed-votes', async (req, res) => {
  const { id } = req.params;
  const count = Math.min(Math.max(parseInt(req.body.count, 10) || 5, 1), 50);
  const dist = Array.isArray(req.body.dist) ? req.body.dist : null;
  const PORT = process.env.PORT || 3000;
  const BASE = `http://127.0.0.1:${PORT}`;
  const { elgamalEncryptWithZKP } = require('../lib/elgamalVote');
  const J = async (path, opts = {}) => {
    const { headers, ...rest } = opts;
    const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json', ...(headers || {}) }, ...rest });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
    if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 120)}`);
    return j;
  };
  try {
    const election = await J(`/api/elections/${encodeURIComponent(id)}`);
    if (election.encryptionMode !== 'elgamal') return res.status(400).json({ error: 'seed-votes는 ElGamal 모드 선거만 지원합니다.' });
    if (election.status !== 'ACTIVE') return res.status(400).json({ error: '활성(ACTIVE) 선거만 투표 주입이 가능합니다.' });
    const cands = election.candidates;
    const pub = (await J(`/api/elections/${encodeURIComponent(id)}/elgamal-pubkey`)).pubKey;
    const bf = (await J(`/api/elections/${encodeURIComponent(id)}/blinding-factor`)).blindingFactor;
    let ok = 0; const counts = {};
    for (let i = 0; i < count; i++) {
      const idx = dist && dist[i] != null ? dist[i] % cands.length : Math.floor(Math.random() * cands.length);
      const voterId = `demo${String((i % 100) + 1).padStart(3, '0')}`;
      const cred = (await J('/api/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: voterId, enrollmentSecret: `${voterId}pw`, electionID: id }) })).credential;
      const vs = crypto.randomBytes(32).toString('hex');
      const nh = crypto.createHash('sha256').update(vs + id + bf).digest('hex');
      const v = elgamalEncryptWithZKP(pub, idx, cands.length);
      await J('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': cred }, body: JSON.stringify({ electionID: id, encryptedCandidateID: v.encrypted, nullifierHash: nh, ballotValidityProof: JSON.stringify(v.proof) }) });
      ok++; counts[cands[idx]] = (counts[cands[idx]] || 0) + 1;
    }
    res.json({ message: `${ok}표 자동 주입 완료`, injected: ok, breakdown: counts });
  } catch (err) {
    console.error('[seed-votes]', err.message);
    res.status(500).json({ error: '투표 자동 주입에 실패했습니다.', debug: err.message });
  }
});

// ── POST /api/elections/:id/close ─────────────────────────────
// 선거 종료 + 자동 집계 트리거 (관리자)
router.post('/:id/close', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    await contract.submitTransaction('CloseElection', id);
    res.json({ message: `선거 ${id}가 종료되었습니다. 집계가 시작됩니다.` });
  } catch (err) {
    console.error('[elections] CloseElection error:', err.message);
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id/tally ───────────────────────────────
// 개표 결과 조회 (누구나, 선거 종료 후 조회 가능)
router.get('/:id/tally', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetTally', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    console.error('[elections] GetTally error:', err.message);
    res.status(404).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections/:id/verify-tally ─────────────────────
// [PAPER-2] 집계 정확성 독립 검증
// Body: { encryptionKeyHex } — 암호화 키로 각 투표를 복호화하여 집계 결과와 대조
router.post('/:id/verify-tally', async (req, res) => {
  const { id } = req.params;
  const { encryptionKeyHex } = req.body || {};
  if (!encryptionKeyHex) {
    return res.status(400).json({ error: 'encryptionKeyHex 필드가 필요합니다.' });
  }

  const { gateway, contract } = await connectGateway();
  try {
    const tallyResult = await contract.evaluateTransaction('GetTally', id);
    const tally = JSON.parse(Buffer.from(tallyResult).toString('utf8'));

    if (!tally.decryptionProofs || tally.decryptionProofs.length === 0) {
      return res.json({ verified: false, reason: '복호화 증명이 없습니다.' });
    }

    // 각 decryptionProof를 독립 검증
    const key = Buffer.from(encryptionKeyHex, 'hex');
    const verificationResults = [];
    const recount = {};

    for (const proof of tally.decryptionProofs) {
      // AES-256-GCM 복호화
      const data = Buffer.from(proof.encryptedCandidateID, 'hex');
      const nonce = data.subarray(0, 12);
      const cipherAndTag = data.subarray(12);
      // GCM tag는 마지막 16바이트
      const authTag = cipherAndTag.subarray(cipherAndTag.length - 16);
      const ciphertext = cipherAndTag.subarray(0, cipherAndTag.length - 16);

      let decrypted = null;
      let valid = false;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(authTag);
        decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        const expectedHash = crypto.createHash('sha256').update(decrypted).digest('hex');
        valid = expectedHash === proof.decryptedHash;
        if (valid) {
          recount[decrypted] = (recount[decrypted] || 0) + 1;
        }
      } catch {
        valid = false;
      }

      verificationResults.push({
        nullifierHash: proof.nullifierHash,
        valid,
        decryptedCandidate: valid ? decrypted : null,
      });
    }

    // 재집계 결과와 원본 집계 비교
    const tallyMatch = JSON.stringify(Object.keys(tally.results).sort().map(k => [k, tally.results[k]])) ===
                       JSON.stringify(Object.keys(recount).sort().map(k => [k, recount[k]]));

    // tallyProofHash 재계산
    const sorted = [...tally.decryptionProofs].sort((a, b) => a.nullifierHash.localeCompare(b.nullifierHash));
    const h = crypto.createHash('sha256');
    for (const p of sorted) {
      h.update(p.nullifierHash);
      h.update(p.encryptedCandidateID);
      h.update(p.decryptedHash);
    }
    const recomputedProofHash = h.digest('hex');
    const proofHashMatch = recomputedProofHash === tally.tallyProofHash;

    res.json({
      verified: verificationResults.every(v => v.valid) && tallyMatch && proofHashMatch,
      totalProofs: verificationResults.length,
      validProofs: verificationResults.filter(v => v.valid).length,
      tallyMatch,
      proofHashMatch,
      recount,
      originalResults: tally.results,
    });
  } catch (err) {
    console.error('[elections] verify-tally error:', err.message);
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections/:id/activate ──────────────────────────
// 선거 활성화 (CREATED → ACTIVE, 관리자)
router.post('/:id/activate', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    await contract.submitTransaction('ActivateElection', id);
    res.json({ message: `선거 ${id}가 활성화되었습니다.` });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections/:id/merkle ────────────────────────────
// Merkle Tree 구축 (선거 종료 후, 관리자)
// CloseElection 이후에 호출해야 합니다.
router.post('/:id/merkle', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.submitTransaction('BuildMerkleTree', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id/merkle ─────────────────────────────
// Merkle Root 정보 조회
router.get('/:id/merkle', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetMerkleRoot', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    res.status(404).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /api/elections/:id/proof/:nullifier ────────────────────
// Merkle 포함 증명 조회 (유권자 자신의 투표 검증)
// nullifier: SHA256(voterSecret + electionID) — 클라이언트가 계산
router.get('/:id/proof/:nullifier', async (req, res) => {
  const { id, nullifier } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetMerkleProof', id, nullifier);
    const proof = JSON.parse(Buffer.from(result).toString('utf8'));
    let nullifierRecord = null;
    try {
      const nBytes = await contract.evaluateTransaction('GetNullifier', nullifier);
      nullifierRecord = JSON.parse(Buffer.from(nBytes).toString('utf8'));
    } catch {
      // Nullifier가 아직 없을 수 있음 (미투표 상태) — 무시하고 null 유지
      nullifierRecord = null;
    }
    res.json({
      electionID: id,
      nullifierHash: nullifier,
      candidateCommitment: nullifierRecord?.candidateCommitment || '',
      encryptedCandidateID: nullifierRecord?.encryptedCandidateID || '',
      leafHash: computeMerkleLeafHashFromNullifier(nullifierRecord),
      proof,
    });
  } catch (err) {
    res.status(404).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections/:id/proof ─────────────────────────────
// Deniable Verification: 비밀번호로 Normal/Panic 모드 구분
//
// Body:
//   nullifierHash : string — SHA256(voterSecret + electionID)
//   passwordHash  : string — SHA256(password + nullifierHash)
//                            클라이언트에서 계산 (서버에 평문 비밀번호 전달 금지)
//
// Normal Mode: 실제 투표의 Merkle 포함 증명 반환
// Panic Mode:  더미 nullifier의 포함 증명 반환 (강압자 기만)
//              두 응답이 동일한 구조 → 강압자가 구분 불가
router.post('/:id/proof', async (req, res) => {
  const { id } = req.params;
  const { nullifierHash, passwordHash } = req.body;

  if (!nullifierHash || !passwordHash) {
    return res.status(400).json({ error: 'nullifierHash, passwordHash 필드가 필요합니다.' });
  }

  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction(
      'GetMerkleProofWithPassword', id, nullifierHash, passwordHash
    );
    const proof = JSON.parse(Buffer.from(result).toString('utf8'));
    // 두 모드가 동일한 응답 구조 반환 (의도적 설계)
    res.json({ electionID: id, nullifierHash, proof });
  } catch (err) {
    res.status(400).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /:id/keysharing ──────────────────────────────────────
// Shamir SSS 키 분산 초기화 (CloseElection 이후 호출)
router.post('/:id/keysharing', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const proposal = contract.newProposal('InitKeySharing', { arguments: [id] });
    const tx = await proposal.endorse();
    const submitted = await tx.submit();
    const status = await submitted.getStatus();
    if (!status.successful) throw new Error(`트랜잭션 커밋 실패 (code: ${status.code})`);
    res.json({ message: `선거 ${id}의 키 분산이 초기화되었습니다.` });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /:id/shares ──────────────────────────────────────────
// share 제출 (threshold=2 달성 시 자동 복원 검증)
// Body: { shareIndex: "1"|"2"|"3", shareHex: "..." }
router.post('/:id/shares', async (req, res) => {
  const { id } = req.params;
  const { shareIndex, shareHex } = req.body;
  if (!shareIndex || !shareHex) {
    return res.status(400).json({ error: 'shareIndex, shareHex 필드가 필요합니다.' });
  }
  const { gateway, contract } = await connectGatewayForShareIndex(shareIndex);
  try {
    const proposal = contract.newProposal('SubmitKeyShare', {
      arguments: [id, shareIndex, shareHex],
    });
    const tx = await proposal.endorse();
    const submitted = await tx.submit();
    const st = await submitted.getStatus();
    if (!st.successful) throw new Error(`트랜잭션 커밋 실패 (code: ${st.code})`);
    const result = await contract.evaluateTransaction('GetKeyDecryptionStatus', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ElGamal-v2 trustee operation. The chaincode reads the caller's private
// scalar share and publishes only c1^x_i with a verifiable proof.
router.post('/:id/partial-decryptions', async (req, res) => {
  const { id } = req.params;
  const { shareIndex } = req.body;
  if (!['1', '2', '3'].includes(String(shareIndex))) {
    return res.status(400).json({ error: 'shareIndex는 1, 2, 3 중 하나여야 합니다.' });
  }
  const { gateway, contract } = await connectGatewayForShareIndex(String(shareIndex));
  try {
    const proposal = contract.newProposal('SubmitPartialDecryption', {
      arguments: [id, String(shareIndex)],
    });
    const tx = await proposal.endorse();
    const submitted = await tx.submit();
    const st = await submitted.getStatus();
    if (!st.successful) throw new Error(`트랜잭션 커밋 실패 (code: ${st.code})`);
    const result = await contract.evaluateTransaction('GetKeyDecryptionStatus', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    console.error('[elections] SubmitPartialDecryption error:', err.message, err.details || '');
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /:id/decryption ───────────────────────────────────────
// 키 분산/복원 현황 조회
router.get('/:id/decryption', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetKeyDecryptionStatus', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /:id/vote-counted/:nullifier ──────────────────────────
// [PAPER-8] Receipt-free 투표 포함 확인 (증명 데이터 없음)
router.get('/:id/vote-counted/:nullifier', requireValidElectionID, async (req, res) => {
  const { id, nullifier } = req.params;
  if (!nullifier || !/^[a-f0-9]{64}$/.test(nullifier)) {
    return res.status(400).json({ error: 'nullifierHash 형식이 올바르지 않습니다 (64자 hex)' });
  }
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('VerifyVoteCounted', id, nullifier);
    const parsed = JSON.parse(Buffer.from(result).toString('utf8'));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /:id/publish-audit ───────────────────────────────────
// [PAPER-6] 감사 데이터 공개 게시 (Universal Verifiability)
router.post('/:id/publish-audit', requireValidElectionID, async (req, res) => {
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.submitTransaction('PublishAuditData', req.params.id);
    const bb = JSON.parse(Buffer.from(result).toString('utf8'));
    // [부스 시연] 게시판 공개 = 셔플 시점 → 라이브 표도 도착순서를 섞어 시간 상관(timing) 제거 시각화
    try { demoLive.shuffle(req.params.id); demoLive.pushEvent(req.params.id, 'tally-published', {}); } catch (_) { /* 무시 */ }
    res.json({
      message: '감사 데이터 게시 완료',
      electionID: bb.electionID,
      ballotsPublished: bb.encryptedBallots?.length || 0,
      keyPublished: true,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /:id/bulletin-board ──────────────────────────────────
// [PAPER-6] 공개 감사 데이터 조회 (인증 불필요)
router.get('/:id/bulletin-board', requireValidElectionID, async (req, res) => {
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetBulletinBoard', req.params.id);
    const bb = JSON.parse(Buffer.from(result).toString('utf8'));
    res.json(bb);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /:id/election-bundle-source ─────────────────────────────
// Standalone verifier용 bundle의 공개 source. 서명 private key는 API로 받지 않고
// verifier/bin/mongbas-bundle.js로 각 기관이 offline 서명한다.
router.get('/:id/election-bundle-source', requireValidElectionID, async (req, res) => {
  let organizations;
  try {
    organizations = JSON.parse(process.env.BUNDLE_ORGANIZATIONS_JSON || '[]');
  } catch {
    return res.status(503).json({ error: 'BUNDLE_ORGANIZATIONS_JSON이 유효한 JSON이 아닙니다.' });
  }
  const signatureThreshold = Number(process.env.BUNDLE_SIGNATURE_THRESHOLD || 0);
  const gitCommit = process.env.MONGBAS_GIT_COMMIT;
  const imageDigest = process.env.MONGBAS_IMAGE_DIGEST;
  const softwareVersion = process.env.MONGBAS_SOFTWARE_VERSION;
  if (!Array.isArray(organizations) || organizations.length === 0 ||
      !Number.isSafeInteger(signatureThreshold) || signatureThreshold < 1 || signatureThreshold > organizations.length) {
    return res.status(503).json({ error: 'bundle 조직 공개키/서명 threshold 설정이 없거나 잘못되었습니다.' });
  }
  if (!/^[0-9a-f]{40}$/.test(gitCommit || '') || !/^sha256:[0-9a-f]{64}$/.test(imageDigest || '') || !softwareVersion) {
    return res.status(503).json({ error: 'MONGBAS_GIT_COMMIT, MONGBAS_IMAGE_DIGEST, MONGBAS_SOFTWARE_VERSION을 정확히 설정해야 합니다.' });
  }
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const [electionRaw, boardRaw] = await Promise.all([
      contract.evaluateTransaction('GetElection', id),
      contract.evaluateTransaction('GetBulletinBoard', id),
    ]);
    const election = JSON.parse(Buffer.from(electionRaw).toString('utf8'));
    const board = JSON.parse(Buffer.from(boardRaw).toString('utf8'));
    if (board.encryptionMode !== 'elgamal' || !board.elgamalPubKey) {
      return res.status(409).json({ error: 'bundle v1은 ElGamal 선거만 지원합니다.' });
    }
    const ballots = (board.encryptedBallots || []).filter((ballot) => ballot.encryptedCandidateID);
    if (ballots.length !== board.totalVotes) {
      return res.status(409).json({
        error: '게시 ballot 수와 유효 집계 표수가 달라 독립 bundle을 만들 수 없습니다.',
        reason: 'panic/dummy filtering과 universal verifiability를 동시에 충족하는 padding/filtering proof가 필요합니다.',
      });
    }
    if (ballots.some((ballot) => !ballot.ballotValidityProof)) {
      return res.status(409).json({ error: 'ballot validity proof가 누락된 레거시 투표가 있어 bundle을 만들 수 없습니다.' });
    }
    res.json({
      schema: 'mongbas-election-bundle-source/v1',
      encryptionMode: board.encryptionMode,
      configuration: {
        electionID: id,
        candidates: election.candidates,
        signatureThreshold,
        organizations,
      },
      provenance: { gitCommit, imageDigest, softwareVersion },
      publicKey: board.elgamalPubKey,
      ballots,
      tallyResults: board.tallyResults,
      totalVotes: board.totalVotes,
      decryptionProofs: board.decryptionProofs,
      publishedAt: board.publishedAt,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── POST /:id/verify-public ─────────────────────────────────
// [PAPER-6] 공개 독립 검증 (키 불필요 — Bulletin Board에서 자동 사용)
router.post('/:id/verify-public', requireValidElectionID, async (req, res) => {
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('VerifyTallyPublic', req.params.id);
    const verification = JSON.parse(Buffer.from(result).toString('utf8'));
    res.json(verification);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

// ── GET /:id/shares/:index ────────────────────────────────────
// PDC에서 share 조회 (테스트/관리자용)
router.get('/:id/shares/:index', async (req, res) => {
  const { id, index } = req.params;
  const { gateway, contract } = await connectGatewayForShareIndex(index);
  try {
    const result = await contract.evaluateTransaction('GetKeyShare', id, index);
    res.json({ shareIndex: index, shareHex: Buffer.from(result).toString('utf8') });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
  }
});

module.exports = router;
