/**
 * routes/elections.js — 선거 관련 REST API
 *
 * GET  /api/elections/:id          선거 정보 조회
 * POST /api/elections              선거 생성 (관리자)
 * POST /api/elections/:id/close    선거 종료 + 자동 집계 (관리자)
 * GET  /api/elections/:id/tally    개표 결과 조회
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const { connectGateway, connectGatewayForShareIndex } = require('../gateway');

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
  const { electionID, title, description, candidates, startTime, endTime } = req.body;

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

  const actualStartTime = startTime || Math.floor(Date.now() / 1000);

  const { gateway, contract } = await connectGateway();
  try {
    await contract.submitTransaction(
      'CreateElection',
      electionID,
      title,
      description || '',
      JSON.stringify(candidates),
      String(actualStartTime),
      String(endTime),
    );
    res.status(201).json({ message: '선거가 생성되었습니다.', electionID });
  } catch (err) {
    console.error('[elections] CreateElection error:', err.message);
    res.status(500).json({ error: sanitizeError(err) });
  } finally {
    gateway.close();
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
