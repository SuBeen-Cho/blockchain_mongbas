/**
 * routes/elections.js — 선거 관련 REST API
 *
 * GET  /api/elections/:id          선거 정보 조회
 * POST /api/elections              선거 생성 (관리자)
 * POST /api/elections/:id/close    선거 종료 + 자동 집계 (관리자)
 * GET  /api/elections/:id/tally    개표 결과 조회
 */

'use strict';

const express = require('express');
const { connectGateway } = require('../gateway');

const router = express.Router();

// ── GET /api/elections/:id ─────────────────────────────────────
// 선거 정보 조회 (누구나)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetElection', id);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    res.status(404).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(404).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(404).json({ error: err.message });
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
    res.json({ electionID: id, nullifierHash: nullifier, proof });
  } catch (err) {
    res.status(404).json({ error: err.message });
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
    res.status(400).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
  const { gateway, contract } = await connectGateway();
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  } finally {
    gateway.close();
  }
});

// ── GET /:id/shares/:index ────────────────────────────────────
// PDC에서 share 조회 (테스트/관리자용)
router.get('/:id/shares/:index', async (req, res) => {
  const { id, index } = req.params;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetKeyShare', id, index);
    res.json({ shareIndex: index, shareHex: Buffer.from(result).toString('utf8') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    gateway.close();
  }
});

module.exports = router;
