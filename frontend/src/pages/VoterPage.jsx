/**
 * VoterPage.jsx — 유권자 투표 UI (스텝 기반 플로우)
 *
 * Step 1: 유권자 인증 (Idemix)
 * Step 2: 선거 선택
 * Step 3: 투표 옵션 설정 (Blind Mode, Panic)
 * Step 4: 후보 선택
 * Step 5: 검증 & 제출 (Benaloh Challenge + 제출)
 * Step 6: 완료 & 영수증
 */

import { useState, useEffect } from 'react';
import {
  sha256,
  computeNullifier,
  computePasswordHash,
  encryptCandidateID,
  verifyBenalohAudit,
  elgamalEncrypt,
  generateBallotValidityProof,
  generateVectorBallotV3,
  verifyVectorAuditWitnessV3,
} from '../utils/crypto.js';
import Stepper from '../components/Stepper.jsx';
import HashDisplay from '../components/HashDisplay.jsx';
import Alert from '../components/Alert.jsx';

const API = '/api';
const STEPS = ['인증', '선거 선택', '옵션 설정', '후보 선택', '검증 & 제출', '완료'];

export default function VoterPage() {
  const [step, setStep] = useState(0);

  // ── 선거 조회 ───────────────────────────────────────
  const [electionID, setElectionID] = useState('');
  const [election,   setElection]   = useState(null);

  // ── Idemix 자격증명 ────────────────────────────────
  const [enrollmentID,     setEnrollmentID]     = useState('');
  const [enrollmentSecret, setEnrollmentSecret] = useState('');
  const [idemixCredential, setIdemixCredential] = useState('');
  const [nullifierMaterial, setNullifierMaterial] = useState('');
  const [credStatus,       setCredStatus]       = useState('');

  // ── 투표 입력 ───────────────────────────────────────
  const [candidateID,    setCandidateID]    = useState('');
  const [normalPassword, setNormalPassword] = useState('');
  const [panicPassword,  setPanicPassword]  = useState('');
  const [panicCandidate, setPanicCandidate] = useState('');

  // ── Blind Mode ────────────────────────────────────
  const [blindMode, setBlindMode] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState('');

  // ── Benaloh Challenge ─────────────────────────────
  const [benalohStep, setBenalohStep] = useState('idle');
  const [benalohBallot, setBenalohBallot] = useState(null);
  const [benalohAuditResult, setBenalohAudit] = useState(null);
  const [vectorAuditContext, setVectorAuditContext] = useState(null);

  // ── Panic Credential ──────────────────────────────
  const [panicCredential, setPanicCredential] = useState(false);

  // ── UI 상태 ────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState('');
  const [panicMode, setPanicMode] = useState(false);
  const [credMode, setCredMode] = useState('');

  // ── 암호화 진행 상태 ─────────────────────────────
  const [encProgress, setEncProgress] = useState([]);
  const [showEncComplete, setShowEncComplete] = useState(false);

  // ── ElGamal ────────────────────────────────────────
  const [elgamalPubKey, setElgamalPubKey] = useState(null);
  const isElGamal = election?.encryptionMode === 'elgamal' || election?.encryptionMode === 'elgamal-vector-v3';
	const isVectorV3 = election?.encryptionMode === 'elgamal-vector-v3';

  useEffect(() => {
    fetch('/health').then(r => r.json())
      .then(d => setCredMode(d.idemix?.mode || ''))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!blindMode || !election || !electionID) {
      setEncryptionKey(''); setElgamalPubKey(null); return;
    }
    if (isElGamal) {
      fetch(`${API}/elections/${electionID}/elgamal-pubkey`)
        .then(r => r.json())
        .then(d => { setElgamalPubKey(d.pubKey || null); setEncryptionKey('elgamal'); })
        .catch(() => { setElgamalPubKey(null); setEncryptionKey(''); setError('ElGamal 공개키를 불러오지 못했습니다. 네트워크를 확인하세요.'); });
    } else {
      fetch(`${API}/elections/${electionID}/encryption-key`)
        .then(r => r.json())
        .then(d => setEncryptionKey(d.encryptionKeyHex || ''))
        .catch(() => { setEncryptionKey(''); setError('암호화 키를 불러오지 못했습니다. 네트워크를 확인하세요.'); });
    }
  }, [blindMode, election, electionID, isElGamal]);

  useEffect(() => {
    if (!election || !electionID || !enrollmentID || !enrollmentSecret) return;
    setCredStatus('fetching');
    setIdemixCredential('');
    setNullifierMaterial('');
    fetch(`${API}/credential/idemix`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ enrollmentID, enrollmentSecret, electionID }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.credential && data.nullifierMaterial) {
          setIdemixCredential(data.credential);
          setNullifierMaterial(data.nullifierMaterial);
          setCredStatus('ok');
        }
        else setCredStatus('error');
      })
      .catch(() => setCredStatus('error'));
  }, [election, electionID, enrollmentID, enrollmentSecret]);

  async function fetchElection() {
    setError(''); setElection(null); setIdemixCredential(''); setNullifierMaterial(''); setCredStatus('');
    try {
      const res = await fetch(`${API}/elections/${electionID}`);
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      setElection(data);
      if (data.encryptionMode === 'elgamal-vector-v3') setBlindMode(true);
    } catch (e) { setError(e.message); }
  }

  async function submitVote() {
    if (!nullifierMaterial || !candidateID) {
      return setError('자격증명을 발급받고 후보자를 선택하세요.');
    }
    if (blindMode && !encryptionKey) {
      return setError('Blind Mode: 암호화 키를 불러오지 못했습니다.');
    }
    setLoading(true); setError(''); setResult(null);
    setEncProgress([]);

    try {
      // Step 1: Nullifier
      setEncProgress(['nullifier']);
      const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
      if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
      const { blindingFactor } = await bfRes.json();
      const nullifierHash = await computeNullifier(nullifierMaterial, electionID, blindingFactor);
      setEncProgress(p => [...p, 'nullifier_done']);

      const body = { electionID, nullifierHash };
      let vectorClientNonce = '';

      // Step 2: Encrypt
      setEncProgress(p => [...p, 'encrypt']);
      if (blindMode) {
        if (isElGamal && elgamalPubKey) {
          const candidateIndex = (election?.candidates || []).indexOf(candidateID);
          if (candidateIndex < 0) throw new Error('후보자를 선택해주세요');
          setEncProgress(p => [...p, 'encrypt_done', 'zkp']);
		  if (isVectorV3) {
			const vectorBallot = generateVectorBallotV3(elgamalPubKey, candidateIndex, election.candidates.length);
			body.encryptedCandidateVector = vectorBallot.encryptedCandidateVector;
			body.vectorBallotValidityProof = vectorBallot.vectorBallotValidityProof;
			const nonceBytes = new Uint8Array(32);
			crypto.getRandomValues(nonceBytes);
			vectorClientNonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, '0')).join('');
		  } else {
			const { c1, c2, _r } = elgamalEncrypt(elgamalPubKey, candidateID, candidateIndex);
			body.encryptedCandidateID = `${c1}:${c2}`;
			body.ballotValidityProof = JSON.stringify(generateBallotValidityProof(
			  elgamalPubKey, c1, c2, _r, candidateIndex, election.candidates.length));
		  }
          setEncProgress(p => [...p, 'zkp_done']);
        } else {
          body.encryptedCandidateID = await encryptCandidateID(encryptionKey, candidateID);
          setEncProgress(p => [...p, 'encrypt_done']);
        }
      } else {
        body.candidateID = candidateID;
        setEncProgress(p => [...p, 'encrypt_done']);
      }

      if (normalPassword && panicPassword) {
        body.normalPWHash     = await computePasswordHash(normalPassword, nullifierHash);
        body.panicPWHash      = await computePasswordHash(panicPassword,  nullifierHash);
        body.panicCandidateID = panicCandidate || candidateID;
      }
      if (panicCredential) body.credentialType = 'panic';

      // Step 3: Submit to blockchain
      setEncProgress(p => [...p, 'blockchain']);
      const headers = { 'Content-Type': 'application/json' };
      if (idemixCredential) headers['x-idemix-credential'] = idemixCredential;

      let endpoint = `${API}/vote`;
      if (isVectorV3) {
        const prepareRes = await fetch(`${API}/vote/prepare-vector`, {
          method: 'POST', headers,
          body: JSON.stringify({ ...body, clientNonceHash: await sha256(vectorClientNonce) }),
        });
        const prepared = await prepareRes.json();
        if (!prepareRes.ok || !prepared.ballotID) throw new Error(prepared.error || 'vector-v3 준비 실패');
        body.ballotID = prepared.ballotID;
        endpoint = `${API}/vote/cast-vector`;
      }
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.reason);
      setEncProgress(p => [...p, 'blockchain_done', 'receipt', 'receipt_done']);
      setShowEncComplete(true);

      // 완료 시각화를 2초간 보여준 후 결과 화면으로 전환
      await new Promise(resolve => setTimeout(resolve, 2000));
      setResult({ nullifierHash, blindMode, ...data });
      setStep(5); // 완료 단계로
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setShowEncComplete(false); }
  }

  // ── Benaloh Challenge ─────────────────────────────
  async function benalohPrepare() {
    if (!candidateID) return setError('후보자를 먼저 선택하세요.');
    setLoading(true); setError(''); setBenalohAudit(null);
    try {
      const hdrs = { 'Content-Type': 'application/json' };
      if (idemixCredential) hdrs['x-idemix-credential'] = idemixCredential;
      if (isVectorV3) {
        if (!elgamalPubKey || !nullifierMaterial) throw new Error('vector-v3 공개키 또는 credential이 없습니다.');
        const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
        if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
        const { blindingFactor } = await bfRes.json();
        const nullifierHash = await computeNullifier(nullifierMaterial, electionID, blindingFactor);
        const selectedIndex = election.candidates.indexOf(candidateID);
        const ballot = generateVectorBallotV3(elgamalPubKey, selectedIndex, election.candidates.length);
        const nonceBytes = new Uint8Array(32);
        crypto.getRandomValues(nonceBytes);
        const clientNonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, '0')).join('');
        const res = await fetch(`${API}/vote/prepare-vector`, { method: 'POST', headers: hdrs, body: JSON.stringify({
          electionID, nullifierHash, clientNonceHash: await sha256(clientNonce),
          encryptedCandidateVector: ballot.encryptedCandidateVector,
          vectorBallotValidityProof: ballot.vectorBallotValidityProof,
        }) });
        const data = await res.json();
        if (!res.ok || !data.ballotID) throw new Error(data.error || 'vector-v3 준비 실패');
        setVectorAuditContext({ ballot, clientNonce, nullifierHash, selectedIndex });
        setBenalohBallot(data);
        setBenalohStep('prepared');
        return;
      }
      const res = await fetch(`${API}/vote/prepare`, {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({ electionID, candidateID }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBenalohBallot(data);
      setBenalohStep('prepared');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function benalohAudit() {
    if (!benalohBallot?.ballotID) return;
    setLoading(true); setError('');
    try {
      const hdrs2 = { 'Content-Type': 'application/json' };
      if (idemixCredential) hdrs2['x-idemix-credential'] = idemixCredential;
      if (isVectorV3) {
        if (!vectorAuditContext) throw new Error('vector-v3 audit witness가 메모리에 없습니다. 새로 준비하세요.');
        const { ballot, clientNonce, nullifierHash, selectedIndex } = vectorAuditContext;
        const res = await fetch(`${API}/vote/audit-vector`, { method: 'POST', headers: hdrs2, body: JSON.stringify({
          electionID, ballotID: benalohBallot.ballotID, nullifierHash, selectedIndex, clientNonce,
          randomness: ballot._auditWitness.randomness,
        }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const verified = data.artifactHash === benalohBallot.artifactHash && data.selectedIndex === selectedIndex &&
          verifyVectorAuditWitnessV3(elgamalPubKey, data.encryptedCandidateVector, data.selectedIndex, data.randomness);
        setBenalohAudit({ ...data, candidateID: election.candidates[selectedIndex], clientVerified: verified });
        setBenalohStep('audited');
        return;
      }
      const res = await fetch(`${API}/vote/audit`, {
        method: 'POST', headers: hdrs2,
        body: JSON.stringify({ electionID, ballotID: benalohBallot.ballotID }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const verification = await verifyBenalohAudit(data);
      setBenalohAudit({ ...data, clientVerified: verification.verified });
      setBenalohStep('audited');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  function benalohReset() {
    setBenalohStep('idle'); setBenalohBallot(null); setBenalohAudit(null); setVectorAuditContext(null);
  }

  // ── Navigation ────────────────────────────────────
  const canNext = () => {
    switch (step) {
      case 0: return enrollmentID && enrollmentSecret;
      case 1: return election?.status === 'ACTIVE';
      case 2: return !!nullifierMaterial;
      case 3: return candidateID;
      case 4: return true;
      default: return false;
    }
  };

  const next = () => { if (canNext()) { setError(''); setStep(s => Math.min(s + 1, 5)); } };
  const prev = () => {
    setError('');
    benalohReset();
    // Panic 모드 초기화 (뒤로 갈 때 위협 상태 해제)
    setPanicMode(false);
    setPanicCredential(false);
    setStep(s => Math.max(s - 1, 0));
  };

  // ── Encryption Progress Steps ─────────────────────
  const ENC_STEPS = [
    { key: 'nullifier', label: 'Nullifier 생성', doneKey: 'nullifier_done' },
    { key: 'encrypt', label: blindMode ? (isElGamal ? 'ElGamal 암호화' : 'AES-256-GCM 암호화') : '투표 데이터 준비', doneKey: 'encrypt_done' },
    ...(isElGamal && blindMode ? [{ key: 'zkp', label: 'ZKP 증명 생성', doneKey: 'zkp_done' }] : []),
    { key: 'blockchain', label: '블록체인 기록', doneKey: 'blockchain_done' },
    { key: 'receipt', label: '영수증 생성', doneKey: 'receipt_done' },
  ];

  return (
    <div className="space-y-8">
      {/* 스텝퍼 */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <Stepper steps={STEPS} current={step} />
      </div>

      {/* 에러 */}
      {error && <Alert variant="error">{error}</Alert>}

      {/* ════════ Step 0: 유권자 인증 ════════ */}
      {step === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">유권자 인증</h2>
            <p className="text-sm text-slate-500 mt-1">
              Idemix 익명 자격 증명을 발급받습니다. 블록체인에 신원이 기록되지 않습니다.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">유권자 ID</label>
              <input
                className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm bg-white
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="예: voter1"
                value={enrollmentID}
                onChange={e => setEnrollmentID(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">비밀번호</label>
              <input
                className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm bg-white
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="예: voter1pw"
                type="password"
                value={enrollmentSecret}
                onChange={e => setEnrollmentSecret(e.target.value)}
              />
            </div>
          </div>

          {credStatus === 'ok' && (
            <Alert variant="success">익명 자격증명이 발급되었습니다.</Alert>
          )}
          {credStatus === 'fetching' && (
            <Alert variant="info">자격증명 발급 중...</Alert>
          )}
          {credStatus === 'error' && (
            <Alert variant="error">자격증명 발급 실패 — 유권자 ID/비밀번호를 확인하세요.</Alert>
          )}

          <div className="flex justify-end">
            <button
              onClick={next}
              disabled={!canNext()}
              className="h-11 px-8 bg-blue-600 text-white rounded-lg text-sm font-semibold
                hover:bg-blue-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-1
                transition-all duration-200"
            >
              다음 단계
              <svg className="inline-block w-4 h-4 ml-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* ════════ Step 1: 선거 선택 ════════ */}
      {step === 1 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">선거 선택</h2>
            <p className="text-sm text-slate-500 mt-1">참여할 선거의 ID를 입력하고 조회하세요.</p>
          </div>

          <div className="flex gap-3">
            <input
              className="flex-1 h-11 px-4 border border-slate-200 rounded-lg text-sm bg-white
                focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
              placeholder="예: ELECTION_2026_PRESIDENT"
              value={electionID}
              onChange={e => setElectionID(e.target.value)}
            />
            <button
              onClick={fetchElection}
              className="h-11 px-6 bg-slate-800 text-white rounded-lg text-sm font-semibold
                hover:bg-slate-900 active:scale-[0.98] transition-all duration-200"
            >조회</button>
          </div>

          {election && (
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-5 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-900">{election.title}</h3>
                  <p className="text-sm text-slate-500 mt-0.5">{election.description}</p>
                </div>
                <span className={`
                  px-3 py-1 rounded-full text-xs font-bold
                  ${election.status === 'ACTIVE'
                    ? 'bg-emerald-100 text-emerald-700'
                    : election.status === 'CLOSED'
                      ? 'bg-slate-200 text-slate-600'
                      : 'bg-amber-100 text-amber-700'
                  }
                `}>{election.status}</span>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {election.candidates?.map(c => (
                  <span key={c} className="px-3 py-1 bg-white border border-slate-200 rounded-lg text-sm text-slate-700">{c}</span>
                ))}
              </div>
              {isElGamal && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-[11px] font-bold">ElGamal</span>
                  <span className="text-xs text-slate-500">공개키 동형 암호화 모드</span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <button onClick={prev} className="h-11 px-6 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors duration-200">
              <svg className="inline-block w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              이전
            </button>
            <button
              onClick={next}
              disabled={!canNext()}
              className="h-11 px-8 bg-blue-600 text-white rounded-lg text-sm font-semibold
                hover:bg-blue-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-1
                transition-all duration-200"
            >
              다음 단계
              <svg className="inline-block w-4 h-4 ml-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* ════════ Step 2: 투표 옵션 설정 ════════ */}
      {step === 2 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">투표 옵션 설정</h2>
            <p className="text-sm text-slate-500 mt-1">암호화 모드와 보안 옵션을 설정하세요.</p>
          </div>

          {/* Blind Mode */}
          <label className={`rounded-xl border p-4 transition-colors duration-200 flex items-center gap-3 cursor-pointer ${blindMode ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-slate-50'}`}>
            <input type="checkbox" className="sr-only" checked={blindMode} disabled={isVectorV3} onChange={e => setBlindMode(e.target.checked)} />
            <div className={`w-10 h-6 rounded-full transition-colors duration-200 flex items-center shrink-0 ${blindMode ? 'bg-blue-600 justify-end' : 'bg-slate-300 justify-start'}`}>
              <div className="w-5 h-5 bg-white rounded-full shadow-sm mx-0.5" />
            </div>
            <div className="flex-1">
              <span className="text-sm font-semibold text-slate-800">Blind Mode</span>
              <span className={`text-xs block mt-0.5 ${blindMode && !encryptionKey && error ? 'text-red-500' : 'text-slate-500'}`}>
                {blindMode
                  ? encryptionKey
                    ? isElGamal ? 'ElGamal 공개키 암호화 활성 — ZKP 검증 가능' : 'AES-256-GCM 암호화 활성 — 서버가 평문을 볼 수 없음'
                    : error ? '암호화 키 로딩 실패 — 네트워크 확인 후 재시도' : '암호화 키 로딩 중...'
                  : isVectorV3 ? 'vector-v3는 Blind Mode가 필수입니다.' : '서버에 평문 후보 전달 (기본 모드)'}
              </span>
            </div>
            {isElGamal && blindMode && (
              <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-[11px] font-bold">ElGamal</span>
            )}
          </label>
          {blindMode && encryptionKey && (
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs ${isElGamal ? 'bg-purple-50 border border-purple-200 text-purple-700' : 'bg-blue-50 border border-blue-200 text-blue-700'}`}>
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
              <span>{isElGamal
                ? 'Exponential ElGamal 동형 암호화 — 서버가 투표를 복호화하지 않고 암호문 상태로 집계. Chaum-Pedersen ZKP로 유효성 검증.'
                : 'AES-256-GCM 대칭 암호화 — 후보 ID가 브라우저에서 암호화되어 서버는 평문을 볼 수 없음.'
              }</span>
            </div>
          )}
          {!blindMode && (
            <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
              <span>Blind Mode OFF — 후보 ID가 평문으로 서버에 전달됩니다. Blind Mode를 켜면 클라이언트에서 암호화하여 서버가 투표 내용을 알 수 없게 됩니다.</span>
            </div>
          )}

          {/* Panic Credential */}
          <label className={`rounded-xl border p-4 transition-colors duration-200 flex items-center gap-3 cursor-pointer ${panicCredential ? 'border-red-300 bg-red-50/50' : 'border-slate-200 bg-slate-50'}`}>
            <input type="checkbox" className="sr-only" checked={panicCredential} onChange={e => setPanicCredential(e.target.checked)} />
            <div className={`w-10 h-6 rounded-full transition-colors duration-200 flex items-center shrink-0 ${panicCredential ? 'bg-red-500 justify-end' : 'bg-slate-300 justify-start'}`}>
              <div className="w-5 h-5 bg-white rounded-full shadow-sm mx-0.5" />
            </div>
            <div className="flex-1">
              <span className="text-sm font-semibold text-slate-800">Panic Credential</span>
              <span className="text-xs text-slate-500 block mt-0.5">
                {panicCredential ? '강압 투표 모드 — 이 투표는 집계에서 제외됩니다' : '정상 투표 모드 — 유효한 투표로 집계됩니다'}
              </span>
            </div>
          </label>

          {/* Deniable Passwords */}
          <details className="rounded-xl border border-slate-200 overflow-hidden">
            <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset transition-colors duration-200">
              Deniable Verification 비밀번호 설정 (선택)
              <span className="ml-2 text-[10px] text-slate-400 font-normal">— 강압 상황 대비 가짜 검증 결과 제공</span>
            </summary>
            <div className="px-4 pb-4 space-y-3 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-500">
                강압 상황에서 가짜 증명을 제공하는 보호 기능. Normal 비밀번호로는 실제 투표 증명, Panic 비밀번호로는 가짜 증명이 반환됩니다.
              </p>
              <input
                className="w-full h-10 px-3 border border-slate-200 rounded-lg text-sm
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="Normal 비밀번호 (실제 검증용)"
                type="password" value={normalPassword} onChange={e => setNormalPassword(e.target.value)}
              />
              <input
                className="w-full h-10 px-3 border border-slate-200 rounded-lg text-sm
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="Panic 비밀번호 (강압자에게 보여줄 가짜)"
                type="password" value={panicPassword} onChange={e => setPanicPassword(e.target.value)}
              />
              {normalPassword && panicPassword && (
                <div>
                  <label className="text-xs text-slate-500 block mb-2">강압자에게 보여줄 가짜 후보</label>
                  <div className="flex flex-wrap gap-2">
                    {election?.candidates?.filter(c => c !== candidateID).map(c => (
                      <button
                        key={c}
                        onClick={() => setPanicCandidate(c)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-200 ${
                          panicCandidate === c ? 'bg-red-100 border-red-300 text-red-700' : 'border-slate-200 hover:border-red-300 text-slate-600'
                        }`}
                      >{c}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>

          <div className="flex justify-between">
            <button onClick={prev} className="h-11 px-6 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors duration-200">
              <svg className="inline-block w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              이전
            </button>
            <button
              onClick={next}
              disabled={!canNext()}
              className="h-11 px-8 bg-blue-600 text-white rounded-lg text-sm font-semibold
                hover:bg-blue-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-1
                transition-all duration-200"
            >
              다음 단계
              <svg className="inline-block w-4 h-4 ml-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* ════════ Step 3: 후보 선택 ════════ */}
      {step === 3 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">후보를 선택해주세요</h2>
            <p className="text-sm text-slate-500 mt-1">{election?.title}</p>
          </div>

          <div className="space-y-3">
            {election?.candidates?.map(c => (
              <button
                key={c}
                onClick={() => setCandidateID(c)}
                className={`
                  w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left
                  transition-all duration-200 group
                  ${candidateID === c
                    ? 'border-blue-500 bg-blue-50 shadow-sm'
                    : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/30'
                  }
                `}
              >
                {/* 라디오 인디케이터 */}
                <div className={`
                  w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0
                  transition-all duration-200
                  ${candidateID === c ? 'border-blue-500 bg-blue-500' : 'border-slate-300 group-hover:border-blue-300'}
                `}>
                  {candidateID === c && (
                    <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <span className={`text-base font-semibold ${candidateID === c ? 'text-blue-700' : 'text-slate-800'}`}>
                  {c}
                </span>
              </button>
            ))}
          </div>

          <div className="flex justify-between">
            <button onClick={prev} className="h-11 px-6 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors duration-200">
              <svg className="inline-block w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              이전
            </button>
            <button
              onClick={next}
              disabled={!canNext()}
              className="h-11 px-8 bg-blue-600 text-white rounded-lg text-sm font-semibold
                hover:bg-blue-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-1
                transition-all duration-200"
            >
              다음 단계
              <svg className="inline-block w-4 h-4 ml-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
      )}

      {/* ════════ Step 4: 검증 & 제출 ════════ */}
      {step === 4 && (
        <div className="space-y-6">
          {/* 투표 요약 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-5">
            <div>
              <h2 className="text-xl font-bold text-slate-900">투표 확인 및 제출</h2>
              <p className="text-sm text-slate-500 mt-1">선택을 확인하고 투표를 제출하세요.</p>
            </div>

            <div className="bg-slate-50 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">투표 요약</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-500">선거</span>
                  <p className="font-medium text-slate-800 mt-0.5">{election?.title}</p>
                </div>
                <div>
                  <span className="text-slate-500">선택 후보</span>
                  <p className="font-semibold text-blue-700 mt-0.5">{candidateID}</p>
                </div>
                <div>
                  <span className="text-slate-500">암호화 모드</span>
                  <p className="font-medium text-slate-800 mt-0.5">
                    {blindMode ? (isElGamal ? 'ElGamal 공개키 암호화' : 'AES-256-GCM') : '평문 전달'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Credential 유형</span>
                  <p className={`font-medium mt-0.5 ${panicCredential ? 'text-red-600' : 'text-slate-800'}`}>
                    {panicCredential ? 'Panic (집계 제외)' : '정상'}
                  </p>
                </div>
              </div>
            </div>

            {/* Benaloh Challenge — Cast-as-Intended 검증 */}
            <div className="rounded-xl border-2 border-purple-200 bg-purple-50/30 overflow-hidden">
              <div className="px-4 py-3 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-600 text-xs font-bold">B</span>
                <span className="text-sm font-semibold text-purple-800">{isVectorV3 ? 'Vector audit-or-cast — 의도대로 암호화됐는지 검증' : 'Benaloh Challenge — 의도대로 암호화됐는지 검증'}</span>
                <span className="ml-auto text-[10px] text-purple-500 bg-purple-100 px-2 py-0.5 rounded-full font-medium">Cast-as-Intended</span>
              </div>
              <div className="px-4 pb-4 space-y-3 border-t border-purple-100 pt-3">
                <p className="text-xs text-slate-600">
                  {isVectorV3
                    ? <>브라우저가 생성한 실제 vector-v3 암호문과 ZKP를 먼저 원장에 커밋합니다. Audit을 선택하면 선택 인덱스와 난수로 모든 암호문을 다시 계산하고 이 표를 <span className="font-semibold text-purple-700">영구 폐기</span>합니다. 실제 투표는 새 암호문을 만들어 제출해야 합니다.</>
                    : <>투표 제출 전에 암호화가 내 의도대로 수행되었는지 독립 검증합니다. Audit를 요청하면 서버가 암호화 키를 공개하여 복호화 결과를 확인할 수 있고, 키가 공개된 투표는 비밀이 깨지므로 <span className="font-semibold text-purple-700">자동으로 무효 처리</span>됩니다. 따라서 실제 투표는 Audit 후 새로 제출해야 합니다.</>}
                </p>

                {benalohStep === 'idle' && (
                  <button
                    className="h-10 px-4 rounded-lg border border-purple-300 text-purple-600 text-sm font-medium
                      hover:bg-purple-50 transition-all duration-200"
                    onClick={benalohPrepare} disabled={loading || benalohStep !== 'idle'}
                  >1. Prepare ({isVectorV3 ? 'vector 암호문 커밋' : '암호화 사전 검증'})</button>
                )}

                {benalohStep === 'prepared' && benalohBallot && (
                  <div className="space-y-3">
                    <Alert variant="purple" title="Ballot 준비 완료">
                      <p className="text-xs mt-1">Ballot ID: <code className="bg-white/80 px-1 rounded">{benalohBallot.ballotID}</code></p>
                    </Alert>
                    <div className="flex gap-2">
                      <button
                        className="h-10 px-4 rounded-lg border border-amber-300 text-amber-700 text-sm font-medium
                          hover:bg-amber-50 transition-all duration-200"
                        onClick={benalohAudit} disabled={loading}
                      >2. Audit (검증)</button>
                      <button
                        className="h-10 px-3 rounded-lg border border-slate-200 text-slate-500 text-xs
                          hover:bg-slate-50 transition-all duration-200"
                        onClick={benalohReset}
                      >취소</button>
                    </div>
                  </div>
                )}

                {benalohStep === 'audited' && benalohAuditResult && (
                  <div className="space-y-3">
                    <Alert variant={benalohAuditResult.clientVerified ? 'success' : 'error'}
                           title={benalohAuditResult.clientVerified ? '브라우저 독립 검증 성공' : '검증 실패'}>
                      <p className="text-xs">복호화 결과: <span className="font-semibold">{benalohAuditResult.candidateID}</span> — 내 선택과 일치합니다.</p>
                      {benalohAuditResult.clientVerified && (
                        <p className="text-xs text-slate-500 mt-1">{isVectorV3 ? '공개된 난수로 암호문 전체를 재계산했고 이 준비 표는 audited 상태로 폐기되었습니다. 아래에서 새 암호문으로 실제 투표를 제출하세요.' : '검증을 위해 암호화 키가 공개되었으므로 이 투표는 무효 처리됩니다. 아래에서 실제 투표를 새로 제출하세요.'}</p>
                      )}
                    </Alert>
                    <button
                      className="h-10 px-3 rounded-lg border border-slate-200 text-slate-500 text-xs
                        hover:bg-slate-50 transition-all duration-200"
                      onClick={benalohReset}
                    >초기화</button>
                  </div>
                )}
              </div>
            </div>

            {/* 암호화 진행 시각화 */}
            {(loading || showEncComplete) && encProgress.length > 0 && (
              <div className={`rounded-xl p-5 space-y-3 transition-colors duration-500 ${showEncComplete && !loading ? 'bg-emerald-900' : 'bg-slate-900'}`}>
                <div className="flex items-center gap-2">
                  {showEncComplete && !loading ? (
                    <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  <span className="text-sm font-semibold text-white">
                    {showEncComplete && !loading ? '투표 암호화 완료!' : '투표 암호화 중...'}
                  </span>
                </div>
                {ENC_STEPS.map(({ key, label, doneKey }) => {
                  const started = encProgress.includes(key);
                  const done = encProgress.includes(doneKey);
                  return (
                    <div key={key} className="flex items-center gap-3 text-sm">
                      {done ? (
                        <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : started ? (
                        <svg className="w-4 h-4 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-slate-600" />
                      )}
                      <span className={done ? 'text-emerald-400' : started ? 'text-blue-300' : 'text-slate-600'}>
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 제출 버튼 */}
            {!loading && (
              <div className="space-y-3">
                {panicMode && (
                  <Alert variant="error">
                    Panic Mode 활성 — 이 투표는 집계에서 제외되며, 강압자에게는 정상 화면처럼 표시됩니다.
                  </Alert>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={submitVote}
                    disabled={loading || !nullifierMaterial || !candidateID}
                    className={`flex-1 h-12 text-white rounded-xl font-bold text-sm
                      active:scale-[0.99] disabled:opacity-40 transition-all duration-200 shadow-sm ${
                      panicMode
                        ? 'bg-red-600 hover:bg-red-700 shadow-red-600/20'
                        : 'bg-blue-600 hover:bg-blue-700 shadow-blue-600/20'
                    }`}
                  >
                    {panicMode ? '투표 제출 (Panic Mode)' : blindMode ? '투표 제출 (Blind Mode)' : '투표 제출'}
                  </button>
                  {!panicMode && (
                    <button
                      onClick={() => { setPanicMode(true); setPanicCredential(true); }}
                      className="h-12 px-4 rounded-xl border-2 border-red-200 text-red-500 text-xs font-medium
                        hover:bg-red-50 transition-all duration-200 flex items-center gap-1.5"
                      title="강압 상황에서 누르세요 — 투표는 정상처럼 보이지만 집계에서 제외됩니다"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                      <span>강압 상황<br/><span className="text-[9px] text-red-400">집계 제외</span></span>
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-start">
              <button onClick={prev} className="h-11 px-6 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors duration-200">
                <svg className="inline-block w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                이전
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════ Step 5: 완료 & 영수증 ════════ */}
      {step === 5 && result && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-6">
          {/* 성공 아이콘 */}
          <div className="text-center space-y-3">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-8 h-8 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-slate-900">투표가 성공적으로 제출되었습니다</h2>
            <p className="text-sm text-slate-500">{result.message}</p>
          </div>

          {/* 상태 배지 */}
          <div className="flex flex-wrap gap-2 justify-center">
            <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-semibold">
              E2E 암호화 완료
            </span>
            {result.blindMode && (
              <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-semibold">
                Blind Mode
              </span>
            )}
            {panicCredential && (
              <span className="px-3 py-1 bg-red-100 text-red-700 rounded-full text-xs font-semibold">
                Panic Credential (집계 제외)
              </span>
            )}
            {result.isRevote && (
              <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold">
                재투표 (이전 투표 대체 — Last-Vote-Wins)
              </span>
            )}
          </div>
          {result.isRevote && (
            <Alert variant="warning">
              이전 투표가 이 투표로 대체되었습니다. 동일한 선거별 자격증명은 항상 같은 nullifier로 연결되어 마지막 투표만 집계됩니다.
            </Alert>
          )}

          {/* 추적 번호 */}
          {result.nullifierHash && (
            <div className="space-y-2">
              <HashDisplay label="투표 추적 번호 (Nullifier Hash)" value={result.nullifierHash} />
              <p className="text-xs text-slate-400 text-center">
                이 추적 번호로 "검증" 탭에서 투표 포함 여부를 확인할 수 있습니다.
                재투표 시 최종 1표만 유효합니다.
              </p>
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 text-center">
                <span className="font-semibold">투표 추적 번호를 안전하게 보관하세요.</span> 검증 탭에서 투표 포함 여부를 확인할 때 사용합니다.
              </div>
            </div>
          )}

          {/* 블록체인 합의 정보 */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
            <span><span className="font-bold">2-of-3 다기관 합의</span>로 블록체인에 기록됨 — 선관위, 참관정당, 시민단체 중 2개 이상 기관이 서명하여 단일 기관 조작이 원천 차단됩니다.</span>
          </div>

          {/* 보안 속성 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', label: 'E2E 암호화' },
              { icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', label: '영지식 증명' },
              { icon: 'M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2', label: '익명 투표' },
              { icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', label: '공개 검증' },
            ].map(({ icon, label }) => (
              <div key={label} className="flex flex-col items-center gap-2 p-3 bg-slate-50 rounded-lg">
                <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                </svg>
                <span className="text-[11px] font-medium text-slate-600">{label}</span>
              </div>
            ))}
          </div>

          {/* 새 투표 */}
          <div className="text-center">
            <button
              onClick={() => { setStep(0); setResult(null); setCandidateID(''); setEncProgress([]); setPanicMode(false); setPanicCredential(false); benalohReset(); setBlindMode(false); }}
              className="h-11 px-6 border border-slate-200 rounded-lg text-sm font-medium text-slate-600
                hover:bg-slate-50 transition-all duration-200"
            >처음으로 돌아가기</button>
          </div>
        </div>
      )}
    </div>
  );
}
