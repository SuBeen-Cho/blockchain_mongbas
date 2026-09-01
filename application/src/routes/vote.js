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
 * nullifierHash = SHA256(signedCredentialMaterial + electionID + blindingFactor)
 *
 * 체인코드는 자격증명에 서명된 결합값으로 nullifier를 독립 재계산하여,
 * 자격증명 하나로 임의 nullifier를 여러 개 만드는 중복투표 우회를 차단합니다.
 *
 * ══ Transient 처리 (PDC 비공개 데이터) ══════════════════════════
 *
 * voterID 등 개인 정보는 setTransient()로만 전달합니다.
 * 일반 submit() 인자로 전달하면 오더러를 통해 모든 조직에 노출됩니다.
 *
 * ══ Panic Mode (강압 대응) ═══════════════════════════════════════
 *
 * 서버 세션은 panic 여부를 저장하지 않는다. 부인 가능 검증은 클라이언트가
 * 생성한 해시와 체인코드/PDC 경로에서만 처리한다.
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const { connectGateway } = require('../gateway');
const { fabricConcurrencyGate } = require('../lib/fabricConcurrencyGate');
const { submitTransactionAndWait } = require('../lib/submitTransaction');
const liveCount = require('../lib/liveCount');  // [부스 시연] 라이브 투표 카운터
const demoLive  = require('../lib/demoLive');   // [부스 시연] 라이브 암호문 표 + 셔플 + 이벤트 버스

const router = express.Router();

function buildCredentialTransient(req, electionID) {
  const credentialVerification = {
    credType: req.voter?.credType,
    electionID: req.voter?.electionID || electionID,
    expUnix: req.voter?.expUnix,
    credHash: req.voter?.credHash,
  };
  if (!credentialVerification.credType || !credentialVerification.expUnix || !credentialVerification.credHash) {
    return { error: '유효한 자격증명 메타데이터가 없습니다.' };
  }
  const transientData = {
    credentialVerification: Buffer.from(JSON.stringify(credentialVerification)),
  };
  if (['ed25519', 'hmac', 'ps'].includes(credentialVerification.credType)) {
    const credentialToken = req.headers['x-idemix-credential'] || '';
    if (!credentialToken) return { error: 'credential 원문이 필요합니다.' };
    transientData.credentialToken = Buffer.from(credentialToken);
  }
  if (credentialVerification.credType === 'bbs') {
    if (!req.voter.bbsProof) return { error: 'BBS+ proof presentation이 필요합니다.' };
    transientData.bbsProof = Buffer.from(JSON.stringify(req.voter.bbsProof));
  }
  return { transientData, credentialVerification };
}

// ── POST /api/vote ─────────────────────────────────────────────
// 투표 제출
//
// Body:
//   electionID    : string   — 선거 ID
//   candidateID   : string   — 후보자 ID
//   nullifierHash : string   — SHA256(signedCredentialMaterial + electionID + blindingFactor)
//   voterID       : string   — 유권자 식별자 (PDC 비공개 저장, 원장 미노출)
//
router.post('/', async (req, res) => {
  const { electionID, candidateID, nullifierHash,
          encryptedCandidateID,
          encryptedCandidateVector,
          normalPWHash, panicPWHash, panicCandidateID,
          credentialType,
          ballotValidityProof,
          vectorBallotValidityProof } = req.body;

  // ── 필수 필드 검증 ─────────────────────────────────────────
  // [PAPER-1] blind mode: candidateID 없이 encryptedCandidateID만 제공 가능
  if (!electionID || !nullifierHash) {
    return res.status(400).json({
      error: 'electionID, nullifierHash 필드가 필요합니다.',
    });
  }
  if (!candidateID && !encryptedCandidateID && !encryptedCandidateVector) {
    return res.status(400).json({
      error: 'candidateID, encryptedCandidateID, encryptedCandidateVector 중 하나가 필요합니다.',
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
  let releaseFabricSlot;
  let gateway;
  try {
    // 암호문과 ZKP는 그대로 두고 Fabric 제출 구간에만 backpressure를 적용한다.
    releaseFabricSlot = await fabricConcurrencyGate.acquire();
    const connection = await connectGateway();
    gateway = connection.gateway;
    const { contract } = connection;
    // [PAPER-1] blind mode 판별: encryptedCandidateID가 있으면 blind mode
    const isBlindMode = !candidateID && (!!encryptedCandidateID || !!encryptedCandidateVector);

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
      if (encryptedCandidateID) votePrivateData.encryptedCandidateID = encryptedCandidateID;
      if (encryptedCandidateVector) votePrivateData.encryptedCandidateVector = encryptedCandidateVector;
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
    const credential = buildCredentialTransient(req, electionID);
    if (credential.error) return res.status(403).json({ error: credential.error });
    const credVerification = credential.credentialVerification;
    Object.assign(transientData, credential.transientData);

    // [PAPER-12] Deniable Credential Duality — credentialType을 transient로 전달
    // "panic" 이면 체인코드가 PDC에 credentialType="panic" 저장 → 집계 시 필터링
    if (credentialType === 'panic') {
      transientData.credentialType = Buffer.from('panic');
    }

    // [PAPER-13] Ballot Validity Proof — ElGamal Exponential mode용 ZKP
    if (ballotValidityProof) {
      transientData.ballotValidityProof = Buffer.from(ballotValidityProof);
    }
    if (vectorBallotValidityProof) {
      transientData.vectorBallotValidityProof = Buffer.from(
        typeof vectorBallotValidityProof === 'string' ? vectorBallotValidityProof : JSON.stringify(vectorBallotValidityProof));
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

    // 투표 후 nullifier 조회해서 evictCount 확인
    let evictCount = 0;
    try {
      const nullifierBytes = await contract.evaluateTransaction('GetNullifier', nullifierHash);
      if (nullifierBytes && nullifierBytes.length > 0) {
        const nullifierObj = JSON.parse(Buffer.from(nullifierBytes).toString('utf8'));
        evictCount = nullifierObj.evictCount || 0;
      }
    } catch (_) { /* 조회 실패 시 무시 — evictCount=0 */ }

    // [부스 시연] 라이브 카운터 — 신규 투표만 증가 (재투표는 기존 표 대체이므로 제외)
    if (evictCount === 0) {
      try { liveCount.increment(electionID); } catch (_) { /* 카운터 실패 무시 */ }
    }
    // [부스 시연] 라이브 암호문 표 — 도착한 암호문(c1:c2)+ZKP결과 기록 (재투표는 행 교체)
    try { demoLive.recordVote(electionID, { nullifierHash, ciphertext: encryptedCandidateID, zkpValid: true }); } catch (_) { /* 무시 */ }

    res.json({
      message : evictCount > 0
        ? `재투표가 완료되었습니다. (이전 투표를 대체 — ${evictCount}회차)`
        : '투표가 완료되었습니다.',
      electionID,
      candidateID: isBlindMode ? '(blind)' : candidateID,
      nullifierHash,
      blindMode: isBlindMode,
      isRevote: evictCount > 0,
      evictCount,
    });
  } catch (err) {
    if (err.code === 'FABRIC_QUEUE_FULL' || err.code === 'FABRIC_QUEUE_TIMEOUT') {
      return res.status(503).json({ error: '투표 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    // 재투표 불가 시 체인코드가 에러 반환
    if (err.message && err.message.includes('이미 투표')) {
      return res.status(409).json({ error: '이미 투표한 선거입니다.', nullifierHash });
    }
    console.error('[vote] CastVote error:', err.message);
    res.status(500).json({ error: '투표 처리 중 오류가 발생했습니다.' });
  } finally {
    gateway?.close();
    releaseFabricSlot?.();
  }
});

// ── POST /api/vote/prepare-vector ─────────────────────────────
// Commits the exact vector-v3 ciphertext/proof before audit-or-cast choice.
router.post('/prepare-vector', async (req, res) => {
  const { electionID, nullifierHash, clientNonceHash, encryptedCandidateVector, vectorBallotValidityProof } = req.body;
  if (!electionID || !nullifierHash || !clientNonceHash || !Array.isArray(encryptedCandidateVector) || !vectorBallotValidityProof) {
    return res.status(400).json({ error: 'vector-v3 준비 필드가 누락되었습니다.' });
  }
  const credential = buildCredentialTransient(req, electionID);
  if (credential.error) return res.status(403).json({ error: credential.error });
  const transientData = {
    ...credential.transientData,
    vectorAuditArtifact: Buffer.from(JSON.stringify({ encryptedCandidateVector, vectorBallotValidityProof })),
  };
  let releaseFabricSlot;
  let gateway;
  try {
    releaseFabricSlot = await fabricConcurrencyGate.acquire();
    const connection = await connectGateway();
    gateway = connection.gateway;
    const result = await submitTransactionAndWait(connection.contract, 'PrepareVectorBallot',
      [electionID, nullifierHash, clientNonceHash], { transientData });
    res.json(JSON.parse(Buffer.from(result).toString('utf8')));
  } catch (err) {
    if (err.code === 'FABRIC_QUEUE_FULL' || err.code === 'FABRIC_QUEUE_TIMEOUT') {
      return res.status(503).json({ error: '투표 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    console.error('[vote] PrepareVectorBallot error:', err.message);
    res.status(500).json({ error: 'vector-v3 투표 준비 중 오류가 발생했습니다.' });
  } finally {
    gateway?.close();
    releaseFabricSlot?.();
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
    const result = await submitTransactionAndWait(contract, 'PrepareBallot', [electionID, candidateID]);
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
    // AuditBallot changes the PDC state from prepared to audited. An evaluate
    // proposal is simulation-only and would silently discard that state change.
    const result = await submitTransactionAndWait(contract, 'AuditBallot', [electionID, ballotID]);
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
// 서버 세션 분기 없이 체인코드 GetNullifier만 호출한다.
router.get('/:hash', async (req, res) => {
  const { hash } = req.params;

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
module.exports = router;
