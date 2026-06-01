/**
 * routes/vote.js — 투표 및 Nullifier 확인 API
 *
 * POST /api/vote                  투표 제출
 * POST /api/vote/prepare          Benaloh Challenge: 투표 사전 암호화
 * POST /api/vote/audit            Benaloh Challenge: 투표 검증 (spoil)
 * GET  /api/nullifier/:hash       투표 여부 확인 (최종 1표만 유효 — 재투표 허용)
 *
 * ══ 핵심 프라이버시 설계 ══════════════════════════════════════════
 *
 * nullifierHash = SHA256(voterSecret + electionID)
 *
 * voterSecret은 유권자 브라우저에서만 생성·보관됩니다.
 * 절대 서버로 전송되지 않으며, 서버는 nullifierHash만 받습니다.
 * 따라서 서버(백엔드)는 "누가 어디에 투표했는지" 알 수 없습니다.
 *
 * ══ Transient 처리 (PDC 비공개 데이터) ══════════════════════════
 *
 * voterID 등 개인 정보는 setTransient()로만 전달합니다.
 * 일반 submit() 인자로 전달하면 오더러를 통해 모든 조직에 노출됩니다.
 *
 * ══ Panic Mode (강압 대응) ═══════════════════════════════════════
 *
 * 세션에 panicMode=true 가 설정되어 있으면:
 * - 실제 투표 대신 더미 Nullifier를 반환
 * - 강압자에게 "나는 X에 투표했다"고 속일 수 있음
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const { connectGateway } = require('../gateway');

const router = express.Router();

// ── POST /api/vote ─────────────────────────────────────────────
// 투표 제출
//
// Body:
//   electionID    : string   — 선거 ID
//   candidateID   : string   — 후보자 ID
//   nullifierHash : string   — SHA256(voterSecret + electionID), 클라이언트 계산
//   voterID       : string   — 유권자 식별자 (PDC 비공개 저장, 원장 미노출)
//
// panicPassword (optional):
//   Body에 panicPassword 필드 포함 시 Panic Mode 활성화.
//   세션에 panicMode=true 설정 후 더미 응답 반환.
router.post('/', async (req, res) => {
  const { electionID, candidateID, nullifierHash,
          encryptedCandidateID,
          normalPWHash, panicPWHash, panicCandidateID,
          credentialType,
          ballotValidityProof } = req.body; // [PAPER-12] credentialType, [PAPER-13] ballotValidityProof

  // ── 필수 필드 검증 ─────────────────────────────────────────
  // [PAPER-1] blind mode: candidateID 없이 encryptedCandidateID만 제공 가능
  if (!electionID || !nullifierHash) {
    return res.status(400).json({
      error: 'electionID, nullifierHash 필드가 필요합니다.',
    });
  }
  if (!candidateID && !encryptedCandidateID) {
    return res.status(400).json({
      error: 'candidateID 또는 encryptedCandidateID 중 하나가 필요합니다.',
    });
  }

  // ── [MED-07 FIX] 서버 사이드 Panic Mode 제거 ───────────────────
  // 기존: 서버가 PANIC_PASSWORD 환경변수를 알고 패닉 분기를 직접 처리
  //   → 서버(로그 포함)가 어떤 유권자가 패닉 모드인지 식별 가능
  //   → 강압 저항성(Coercion Resistance) 파괴
  //
  // 개선: 패닉 분기는 체인코드 레벨(GetMerkleProofWithPassword)에서만 처리
  //   → 클라이언트가 normalPWHash/panicPWHash를 transient로 체인코드에 전달
  //   → 체인코드가 비밀번호 해시를 비교해 해당 Merkle 경로 반환
  //   → 서버는 어느 경로인지 알 수 없음 (서버 불투명 설계)
  //   근거: USENIX JETS 2015 "Coercion-Resistant Elections through Consistent Behavior"

  // ── 실제 투표 처리 ─────────────────────────────────────────
  const { gateway, contract } = await connectGateway();
  try {
    // [PAPER-1] blind mode 판별: encryptedCandidateID가 있으면 blind mode
    const isBlindMode = !candidateID && !!encryptedCandidateID;

    // PDC에 저장될 비공개 데이터 (오더러 미전달)
    const votePrivateData = {
      docType:      'votePrivate',
      electionID,
      nullifierHash,
      voteHash: crypto
        .createHash('sha256')
        .update(`${electionID}|${nullifierHash}|${Date.now()}`)
        .digest('hex'),
    };
    // blind mode: 클라이언트가 암호화한 candidateID를 transient에 포함
    if (isBlindMode) {
      votePrivateData.encryptedCandidateID = encryptedCandidateID;
    }

    // ※ transientData로 전달 — PDC 경로로만 피어에 전달됨
    // @hyperledger/fabric-gateway v1.x API: newProposal → endorse → submit → getStatus
    // submit()은 오더러 전송까지만 기다림. 커밋 확인을 위해 getStatus() 필요.
    const transientData = {
      votePrivate: Buffer.from(JSON.stringify(votePrivateData)),
    };

    // [CRIT-01/02 FIX] 자격증명 메타데이터를 체인코드로 전달 — 체인코드 독립 검증용
    // req.voter는 requireVoterAuth 미들웨어(auth.js)가 설정. credType/expUnix/credHash 포함.
    // 체인코드(verifyCredentialTransient)가 만료·선거ID 바인딩·유형을 독립 검증.
    const credVerification = {
      credType:   req.voter.credType,
      electionID: req.voter.electionID || electionID,
      expUnix:    req.voter.expUnix,
      credHash:   req.voter.credHash,
    };
    if (!credVerification.credType || !credVerification.expUnix || !credVerification.credHash) {
      return res.status(403).json({ error: '유효한 자격증명 메타데이터가 없습니다.' });
    }
    transientData.credentialVerification = Buffer.from(JSON.stringify(credVerification));
    // [PAPER-4] 체인코드 직접 검증을 위해 credential 원문 전달
    if (['ed25519', 'hmac', 'ps'].includes(credVerification.credType)) {
      const credHeader = req.headers['x-idemix-credential'] || '';
      if (!credHeader) return res.status(403).json({ error: 'credential 원문이 필요합니다.' });
      transientData.credentialToken = Buffer.from(credHeader);
    }
    if (credVerification.credType === 'bbs') {
      if (!req.voter.bbsProof) return res.status(403).json({ error: 'BBS+ proof presentation이 필요합니다.' });
      transientData.bbsProof = Buffer.from(JSON.stringify(req.voter.bbsProof));
    }

    // [PAPER-12] Deniable Credential Duality — credentialType을 transient로 전달
    // "panic" 이면 체인코드가 PDC에 credentialType="panic" 저장 → 집계 시 필터링
    if (credentialType === 'panic') {
      transientData.credentialType = Buffer.from('panic');
    }

    // [PAPER-13] Ballot Validity Proof — ElGamal Exponential mode용 ZKP
    if (ballotValidityProof) {
      transientData.ballotValidityProof = Buffer.from(ballotValidityProof);
    }

    // Panic Mode 비밀번호 해시가 제공된 경우 PDC에 함께 저장
    // 클라이언트가 SHA256(password + nullifierHash) 계산 후 전달 (평문 전달 금지)
    if (normalPWHash && panicPWHash) {
      const voterPWData = {
        normalPWHash,
        panicPWHash,
        panicCandidateID: panicCandidateID || '',
      };
      transientData.voterPW = Buffer.from(JSON.stringify(voterPWData));
    }

    // blind mode: candidateID를 빈 문자열로 전달 → 체인코드가 transient의 encryptedCandidateID 사용
    const proposal = contract.newProposal('CastVote', {
      arguments: [electionID, isBlindMode ? '' : candidateID, nullifierHash],
      transientData,
    });
    const transaction = await proposal.endorse();
    const submitted = await transaction.submit();
    const status = await submitted.getStatus();
    if (!status.successful) {
      throw new Error(`트랜잭션 커밋 실패 (status: ${status.code})`);
    }

    res.json({
      message : '투표가 완료되었습니다.',
      electionID,
      candidateID: isBlindMode ? '(blind)' : candidateID,
      nullifierHash,
      blindMode: isBlindMode,
    });
  } catch (err) {
    // 재투표 불가 시 체인코드가 에러 반환
    if (err.message && err.message.includes('이미 투표')) {
      return res.status(409).json({ error: '이미 투표한 선거입니다.', nullifierHash });
    }
    console.error('[vote] CastVote error:', err.message);
    res.status(500).json({ error: '투표 처리 중 오류가 발생했습니다.', debug: err.message });
  } finally {
    gateway.close();
  }
});

// ── POST /api/vote/prepare ────────────────────────────────────
// [PAPER-3] Benaloh Challenge: 투표 사전 암호화 (commit phase)
// 유권자가 후보자를 선택하면 체인코드가 암호화하고 commitment을 반환.
// 유권자는 이후 audit(검증) 또는 cast(투표) 중 하나를 선택.
router.post('/prepare', async (req, res) => {
  const { electionID, candidateID } = req.body;
  if (!electionID || !candidateID) {
    return res.status(400).json({ error: 'electionID, candidateID 필드가 필요합니다.' });
  }

  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.submitTransaction('PrepareBallot', electionID, candidateID);
    const ballot = JSON.parse(Buffer.from(result).toString('utf8'));
    res.json(ballot);
  } catch (err) {
    console.error('[vote] PrepareBallot error:', err.message);
    res.status(500).json({ error: '투표 준비 중 오류가 발생했습니다.' });
  } finally {
    gateway.close();
  }
});

// ── POST /api/vote/audit ─────────────────────────────────────
// [PAPER-3] Benaloh Challenge: 투표 검증 (audit/spoil phase)
// 암호화 키와 평문을 공개하여 유권자가 암호문 정확성을 독립 검증.
// audit된 투표는 폐기되며 실제 투표에 사용할 수 없음.
router.post('/audit', async (req, res) => {
  const { electionID, ballotID } = req.body;
  if (!electionID || !ballotID) {
    return res.status(400).json({ error: 'electionID, ballotID 필드가 필요합니다.' });
  }

  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('AuditBallot', electionID, ballotID);
    const auditResult = JSON.parse(Buffer.from(result).toString('utf8'));
    res.json(auditResult);
  } catch (err) {
    console.error('[vote] AuditBallot error:', err.message);
    res.status(500).json({ error: '투표 검증 중 오류가 발생했습니다.' });
  } finally {
    gateway.close();
  }
});

// ── GET /api/nullifier/:hash ───────────────────────────────────
// 투표 여부 확인 (최종 1표만 유효 — 재투표 허용)
//
// Panic Mode 중: 실제 Nullifier 대신 가짜 Nullifier 반환
// 정상 모드  : 체인코드 GetNullifier 호출
router.get('/:hash', async (req, res) => {
  const { hash } = req.params;

  // ── Panic Mode: 가짜 Nullifier 반환 ───────────────────────
  if (req.session && req.session.panicMode) {
    // 세션에 저장된 가짜 해시를 강압자에게 표시
    return res.json({
      nullifierHash : req.session.fakeNullifierHash || hash,
      candidateID   : req.session.panicCandidateID  || 'CANDIDATE_A',
      note          : '(panic mode — dummy response)',
    });
  }

  // ── 실제 Nullifier 조회 ────────────────────────────────────
  const { gateway, contract } = await connectGateway();
  try {
    const result = await contract.evaluateTransaction('GetNullifier', hash);
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    // 해시가 없으면 아직 투표 안 한 상태
    res.status(404).json({ error: '해당 Nullifier가 존재하지 않습니다. (미투표 상태)', hash });
  } finally {
    gateway.close();
  }
});

// ── POST /api/panic/reset ──────────────────────────────────────
// Panic Mode 해제 (정상 비밀번호로 로그인 시 클라이언트에서 호출)
router.post('/panic/reset', (req, res) => {
  req.session.panicMode         = false;
  req.session.fakeNullifierHash = null;
  req.session.panicCandidateID  = null;
  req.session.panicElectionID   = null;
  res.json({ message: 'Panic Mode가 해제되었습니다.' });
});

module.exports = router;
