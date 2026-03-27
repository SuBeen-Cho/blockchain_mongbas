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
    res.json(JSON.parse(result.toString()));
  } catch (err) {
    res.status(404).json({ error: err.message });
  } finally {
    gateway.close();
  }
});

// ── POST /api/elections ────────────────────────────────────────
// 선거 생성 (관리자)
// Body: { electionID, title, description, candidates: [], endTime }
// endTime: Unix timestamp (초)
router.post('/', async (req, res) => {
  const { electionID, title, description, candidates, endTime } = req.body;

  if (!electionID || !title || !candidates || !Array.isArray(candidates) || !endTime) {
    return res.status(400).json({
      error: 'electionID, title, candidates(배열), endTime 필드가 필요합니다.',
    });
  }

  const { gateway, contract } = await connectGateway();
  try {
    await contract.submitTransaction(
      'CreateElection',
      electionID,
      title,
      description || '',
      JSON.stringify(candidates),
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
    res.json(JSON.parse(result.toString()));
  } catch (err) {
    res.status(404).json({ error: err.message });
  } finally {
    gateway.close();
  }
});

module.exports = router;
