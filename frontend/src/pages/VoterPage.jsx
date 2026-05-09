/**
 * VoterPage.jsx — 유권자 투표 UI (Idemix 자격증명 연동)
 *
 * 핵심 프라이버시 원칙:
 *   - voterSecret은 이 컴포넌트에서만 생성·보관, 절대 서버 전송 안 함
 *   - nullifierHash = SHA256(voterSecret + electionID + blindingFactor) — 브라우저에서 계산
 *   - Idemix credential: 서버에서 발급, voterID 미포함 → 익명 자격 증명
 *   - 강압 상황을 위한 Panic Password 지원
 *   - [PAPER-1] Blind Mode: 클라이언트 AES-256-GCM 암호화 → 서버가 평문 후보 볼 수 없음
 *   - [PAPER-3] Benaloh Challenge: 투표 암호화 정확성 독립 검증
 */

import { useState, useEffect, useRef } from 'react';
import {
  computeNullifier,
  computePasswordHash,
  generateVoterSecret,
  encryptCandidateID,
  verifyBenalohAudit,
  elgamalEncrypt,
} from '../utils/crypto.js';

const API = '/api';

export default function VoterPage() {
  // ── 선거 조회 ───────────────────────────────────────
  const [electionID, setElectionID] = useState('');
  const [election,   setElection]   = useState(null);

  // ── Idemix 자격증명 ────────────────────────────────
  const [enrollmentID,     setEnrollmentID]     = useState('');
  const [enrollmentSecret, setEnrollmentSecret] = useState('');
  const [idemixCredential, setIdemixCredential] = useState('');
  const [credStatus,       setCredStatus]       = useState('');  // 'fetching' | 'ok' | 'error' | ''

  // ── 투표 입력 ───────────────────────────────────────
  const [voterSecret,    setVoterSecret]    = useState('');
  const [candidateID,    setCandidateID]    = useState('');
  const [normalPassword, setNormalPassword] = useState('');
  const [panicPassword,  setPanicPassword]  = useState('');
  const [panicCandidate, setPanicCandidate] = useState('');

  // ── [PAPER-1] Blind Mode ───────────────────────────
  const [blindMode, setBlindMode] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState('');

  // ── [PAPER-3] Benaloh Challenge ────────────────────
  const [benalohStep, setBenalohStep] = useState('idle'); // 'idle' | 'prepared' | 'audited'
  const [benalohBallot, setBenalohBallot] = useState(null);
  const [benalohAuditResult, setBenalohAudit] = useState(null);

  // ── [PAPER-12] Deniable Credential Duality ─────────
  const [panicCredential, setPanicCredential] = useState(false); // 패닉 투표 모드

  // ── UI 상태 ─────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState('');
  const [panicMode, setPanicMode] = useState(false);
  const [credMode, setCredMode] = useState('');

  // ── Credential 모드 확인 (health check) ────────────
  useEffect(() => {
    fetch('/health').then(r => r.json())
      .then(d => setCredMode(d.idemix?.mode || ''))
      .catch(() => {});
  }, []);

  // ── [PAPER-1/11] Blind Mode: 선거 암호화 키 조회 ────
  const [elgamalPubKey, setElgamalPubKey] = useState(null);
  const isElGamal = election?.encryptionMode === 'elgamal';

  useEffect(() => {
    if (!blindMode || !election || !electionID) {
      setEncryptionKey(''); setElgamalPubKey(null); return;
    }
    if (isElGamal) {
      // ElGamal 공개키 조회
      fetch(`${API}/elections/${electionID}/elgamal-pubkey`)
        .then(r => r.json())
        .then(d => { setElgamalPubKey(d.pubKey || null); setEncryptionKey('elgamal'); })
        .catch(() => { setElgamalPubKey(null); setEncryptionKey(''); });
    } else {
      // AES 키 조회
      fetch(`${API}/elections/${electionID}/encryption-key`)
        .then(r => r.json())
        .then(d => setEncryptionKey(d.encryptionKeyHex || ''))
        .catch(() => setEncryptionKey(''));
    }
  }, [blindMode, election, electionID, isElGamal]);

  // ── Idemix 자격증명 사전 발급 ─────────────────────
  // 선거 조회 후 백그라운드에서 자동 발급 (ZKP 사전 생성 최적화)
  useEffect(() => {
    if (!election || !electionID || !enrollmentID || !enrollmentSecret) return;

    setCredStatus('fetching');
    setIdemixCredential('');

    fetch(`${API}/credential/idemix`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ enrollmentID, enrollmentSecret, electionID }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.credential) {
          setIdemixCredential(data.credential);
          setCredStatus('ok');
        } else {
          setCredStatus('error');
        }
      })
      .catch(() => setCredStatus('error'));
  }, [election, electionID, enrollmentID, enrollmentSecret]);

  async function fetchElection() {
    setError(''); setElection(null); setIdemixCredential(''); setCredStatus('');
    try {
      const res = await fetch(`${API}/elections/${electionID}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setElection(await res.json());
    } catch (e) { setError(e.message); }
  }

  async function submitVote() {
    if (!voterSecret || !candidateID) {
      return setError('유권자 비밀값과 후보자를 선택하세요.');
    }
    if (blindMode && !encryptionKey) {
      return setError('Blind Mode: 암호화 키를 불러오지 못했습니다.');
    }
    setLoading(true); setError(''); setResult(null);
    try {
      const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
      if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
      const { blindingFactor } = await bfRes.json();
      const nullifierHash = await computeNullifier(voterSecret, electionID, blindingFactor);

      const body = { electionID, nullifierHash };

      // [PAPER-1/11] Blind Mode 암호화
      if (blindMode) {
        if (isElGamal && elgamalPubKey) {
          // [PAPER-11] ElGamal 공개키 암호화 (비결정론적, 랜덤 r)
          const { c1, c2 } = elgamalEncrypt(elgamalPubKey, candidateID);
          body.encryptedCandidateID = `${c1}:${c2}`;
        } else {
          // AES-256-GCM 대칭키 암호화 (결정론적 nonce)
          body.encryptedCandidateID = await encryptCandidateID(encryptionKey, candidateID);
        }
      } else {
        body.candidateID = candidateID;
      }

      if (normalPassword && panicPassword) {
        body.normalPWHash     = await computePasswordHash(normalPassword, nullifierHash);
        body.panicPWHash      = await computePasswordHash(panicPassword,  nullifierHash);
        body.panicCandidateID = panicCandidate || candidateID;
      }

      // [PAPER-12] Deniable Credential Duality — 패닉 투표 모드
      if (panicCredential) {
        body.credentialType = 'panic';
      }

      const headers = { 'Content-Type': 'application/json' };
      if (idemixCredential) {
        headers['x-idemix-credential'] = idemixCredential;
      }

      const res = await fetch(`${API}/vote`, {
        method: 'POST',
        headers,
        body:   JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.reason);
      setResult({ nullifierHash, blindMode, ...data });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  // ── [PAPER-3] Benaloh Challenge ────────────────────
  async function benalohPrepare() {
    if (!candidateID) return setError('후보자를 먼저 선택하세요.');
    setLoading(true); setError(''); setBenalohAudit(null);
    try {
      const res = await fetch(`${API}/vote/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`${API}/vote/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electionID, ballotID: benalohBallot.ballotID }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // 브라우저에서 독립 검증
      const verification = await verifyBenalohAudit(data);
      setBenalohAudit({ ...data, clientVerified: verification.verified });
      setBenalohStep('audited');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  function benalohReset() {
    setBenalohStep('idle');
    setBenalohBallot(null);
    setBenalohAudit(null);
  }

  async function activatePanicMode() {
    setPanicMode(true);
    setResult({ message: '(Panic Mode 활성화됨) 강압자에게는 정상 화면처럼 보입니다.' });
  }

  return (
    <div className="space-y-5">

      {/* 유권자 로그인 (Idemix 자격증명 발급용) */}
      <section className="bg-white rounded-xl shadow p-5 space-y-3">
        <h2 className="font-bold text-gray-700">유권자 인증 (Idemix)</h2>
        <p className="text-xs text-gray-400">
          자격증명은 voterID를 포함하지 않습니다 — 블록체인에 신원이 기록되지 않습니다.
        </p>
        <div className="flex gap-2">
          <input
            className="border rounded px-3 py-2 flex-1 text-sm"
            placeholder="유권자 ID (예: voter1)"
            value={enrollmentID}
            onChange={e => setEnrollmentID(e.target.value)}
          />
          <input
            className="border rounded px-3 py-2 flex-1 text-sm"
            placeholder="비밀번호 (예: voter1pw)"
            type="password"
            value={enrollmentSecret}
            onChange={e => setEnrollmentSecret(e.target.value)}
          />
        </div>
        {credStatus === 'ok'       && <p className="text-xs text-green-600">자격증명 발급 완료 (익명 자격 확인됨)</p>}
        {credStatus === 'fetching' && <p className="text-xs text-blue-500">자격증명 발급 중...</p>}
        {credStatus === 'error'    && <p className="text-xs text-red-500">자격증명 발급 실패 - 유권자 ID/비밀번호 확인</p>}
        {credMode && (
          <p className="text-xs text-gray-400">
            인증 모드: <span className="font-mono font-medium text-gray-600">{credMode}</span>
          </p>
        )}
      </section>

      {/* 선거 조회 */}
      <section className="bg-white rounded-xl shadow p-5">
        <h2 className="font-bold text-gray-700 mb-3">선거 조회</h2>
        <div className="flex gap-2">
          <input
            className="border rounded px-3 py-2 flex-1 text-sm"
            placeholder="선거 ID (예: ELECTION_2026_PRESIDENT)"
            value={electionID}
            onChange={e => setElectionID(e.target.value)}
          />
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"
            onClick={fetchElection}
          >조회</button>
        </div>

        {election && (
          <div className="mt-3 p-3 bg-blue-50 rounded text-sm space-y-1">
            <p className="font-semibold">{election.title}</p>
            <p className="text-gray-500">{election.description}</p>
            <p>
              상태: <span className={`font-bold ${election.status === 'ACTIVE' ? 'text-green-600' : 'text-gray-500'}`}>
                {election.status}
              </span>
            </p>
            <p className="text-gray-500">후보: {election.candidates?.join(', ')}</p>
          </div>
        )}
      </section>

      {/* 투표 입력 */}
      {election?.status === 'ACTIVE' && (
        <section className="bg-white rounded-xl shadow p-5 space-y-4">
          <h2 className="font-bold text-gray-700">투표</h2>

          {/* [PAPER-1] Blind Mode 토글 */}
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded border">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={blindMode}
                onChange={e => setBlindMode(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="font-medium">Blind Mode (PAPER-1)</span>
            </label>
            <span className="text-xs text-gray-500">
              {blindMode
                ? encryptionKey
                  ? isElGamal
                    ? 'ElGamal 공개키 암호화 활성 (PAPER-11) — ZKP로 복호화 검증 가능'
                    : 'AES-256-GCM 암호화 활성 (PAPER-1) — 서버가 평문 후보를 볼 수 없음'
                  : '암호화 키 로딩 중...'
                : '서버에 평문 후보 전달 (기본 모드)'}
            </span>
            {isElGamal && (
              <span className="ml-2 text-xs font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded">
                ElGamal
              </span>
            )}
          </div>

          {/* [PAPER-12] Panic Credential 토글 */}
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded border border-red-200">
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={panicCredential}
                onChange={e => setPanicCredential(e.target.checked)}
                className="w-4 h-4 accent-red-500"
              />
              <span className="font-medium text-red-700">Panic Credential (PAPER-12)</span>
            </label>
            <span className="text-xs text-red-500">
              {panicCredential
                ? '강압 투표 모드 — 이 투표는 집계에서 제외됩니다 (PDC Cleansing-Hiding)'
                : '정상 투표 모드 — 유효한 투표로 집계됩니다'}
            </span>
          </div>

          {/* voterSecret */}
          <div>
            <label className="block text-xs text-gray-500 mb-1 font-medium">
              유권자 비밀값 <span className="text-red-500">(서버 미전송, 로컬 보관 필수)</span>
            </label>
            <div className="flex gap-2">
              <input
                className="border rounded px-3 py-2 flex-1 text-sm font-mono"
                placeholder="직접 입력하거나 자동 생성"
                value={voterSecret}
                onChange={e => setVoterSecret(e.target.value)}
              />
              <button
                className="border border-gray-300 px-3 py-2 rounded text-xs hover:bg-gray-50"
                onClick={() => setVoterSecret(generateVoterSecret())}
              >자동 생성</button>
            </div>
            <p className="text-xs text-gray-400 mt-1">이 값을 잃어버리면 E2E 검증 불가합니다.</p>
          </div>

          {/* 후보 선택 */}
          <div>
            <label className="block text-xs text-gray-500 mb-1 font-medium">후보자 선택</label>
            <div className="flex flex-wrap gap-2">
              {election.candidates?.map(c => (
                <button
                  key={c}
                  onClick={() => setCandidateID(c)}
                  className={`px-4 py-2 rounded border text-sm font-medium transition-colors ${
                    candidateID === c
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-gray-300 hover:border-blue-400'
                  }`}
                >{c}</button>
              ))}
            </div>
          </div>

          {/* Deniable Verification 비밀번호 (선택) */}
          <details className="border rounded p-3">
            <summary className="text-sm font-medium cursor-pointer text-gray-600">
              Deniable Verification 비밀번호 설정 (선택)
            </summary>
            <div className="mt-3 space-y-2 text-sm">
              <p className="text-xs text-gray-500">
                강압 상황에서 가짜 증명을 제공하는 보호 기능.
                Normal 비밀번호로는 실제 투표 증명, Panic 비밀번호로는 가짜 증명이 반환됩니다.
              </p>
              <input
                className="border rounded px-3 py-2 w-full"
                placeholder="Normal 비밀번호 (실제 검증용)"
                type="password"
                value={normalPassword}
                onChange={e => setNormalPassword(e.target.value)}
              />
              <input
                className="border rounded px-3 py-2 w-full"
                placeholder="Panic 비밀번호 (강압자에게 보여줄 가짜)"
                type="password"
                value={panicPassword}
                onChange={e => setPanicPassword(e.target.value)}
              />
              <div>
                <label className="text-xs text-gray-500 block mb-1">강압자에게 보여줄 가짜 후보</label>
                <div className="flex flex-wrap gap-2">
                  {election.candidates?.filter(c => c !== candidateID).map(c => (
                    <button
                      key={c}
                      onClick={() => setPanicCandidate(c)}
                      className={`px-3 py-1 rounded border text-xs ${
                        panicCandidate === c ? 'bg-red-100 border-red-400' : 'border-gray-300'
                      }`}
                    >{c}</button>
                  ))}
                </div>
              </div>
            </div>
          </details>

          {/* [PAPER-3] Benaloh Challenge */}
          <details className="border rounded p-3">
            <summary className="text-sm font-medium cursor-pointer text-gray-600">
              Benaloh Challenge — 투표 암호화 검증 (PAPER-3, 선택)
            </summary>
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-xs text-gray-500">
                투표를 제출하기 전에 암호화가 올바르게 수행되었는지 검증합니다.
                Prepare → Audit(검증) → 검증 성공 확인 후 실제 투표를 제출하세요.
                (Audit된 투표는 폐기되며, 새로운 투표를 제출해야 합니다.)
              </p>

              {benalohStep === 'idle' && (
                <button
                  className="px-4 py-2 rounded border border-purple-400 text-purple-600 text-sm hover:bg-purple-50"
                  onClick={benalohPrepare}
                  disabled={loading || !candidateID}
                >
                  1. Prepare (암호화 사전 검증)
                </button>
              )}

              {benalohStep === 'prepared' && benalohBallot && (
                <div className="space-y-2">
                  <div className="bg-purple-50 border border-purple-200 rounded p-3 text-xs">
                    <p className="font-medium text-purple-700 mb-1">Ballot 준비 완료</p>
                    <p>Ballot ID: <code className="bg-white px-1 rounded">{benalohBallot.ballotID}</code></p>
                    <p>Commitment: <code className="bg-white px-1 rounded break-all">{benalohBallot.commitment}</code></p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="px-4 py-2 rounded border border-yellow-400 text-yellow-700 text-sm hover:bg-yellow-50"
                      onClick={benalohAudit}
                      disabled={loading}
                    >
                      2. Audit (암호화 검증)
                    </button>
                    <button
                      className="px-3 py-2 rounded border border-gray-300 text-gray-500 text-xs hover:bg-gray-50"
                      onClick={benalohReset}
                    >
                      취소
                    </button>
                  </div>
                </div>
              )}

              {benalohStep === 'audited' && benalohAuditResult && (
                <div className="space-y-2">
                  <div className={`border rounded p-3 text-xs ${
                    benalohAuditResult.clientVerified
                      ? 'bg-green-50 border-green-200'
                      : 'bg-red-50 border-red-200'
                  }`}>
                    <p className={`font-medium mb-1 ${benalohAuditResult.clientVerified ? 'text-green-700' : 'text-red-700'}`}>
                      {benalohAuditResult.clientVerified
                        ? '브라우저 독립 검증 성공 — 암호화가 정확합니다'
                        : '검증 실패 — 암호화 불일치'}
                    </p>
                    <p>후보: <code className="bg-white px-1 rounded">{benalohAuditResult.candidateID}</code></p>
                    <p className="text-gray-500 mt-1">이 투표는 폐기되었습니다. 아래 버튼으로 실제 투표를 제출하세요.</p>
                  </div>
                  <button
                    className="px-3 py-2 rounded border border-gray-300 text-gray-500 text-xs hover:bg-gray-50"
                    onClick={benalohReset}
                  >
                    초기화
                  </button>
                </div>
              )}
            </div>
          </details>

          {/* 투표 제출 */}
          {!panicMode && (
            <div className="flex justify-between items-center">
              <button
                className={`w-full py-3 rounded-lg font-bold text-white text-sm ${
                  loading ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
                }`}
                onClick={submitVote}
                disabled={loading}
              >
                {loading ? '처리 중...' : blindMode ? '투표 제출 (Blind Mode)' : '투표 제출'}
              </button>
              <button
                className="ml-3 px-4 py-3 rounded-lg border border-red-300 text-red-500 text-xs hover:bg-red-50 whitespace-nowrap"
                onClick={activatePanicMode}
                title="강압 상황에서 누르세요"
              >Panic</button>
            </div>
          )}

          {panicMode && (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
              Panic Mode 활성 — 강압자에게는 정상 화면처럼 표시됩니다.
            </div>
          )}
        </section>
      )}

      {/* 결과 */}
      {error  && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>}
      {result && (
        <div className="bg-green-50 border border-green-200 rounded p-4 text-sm space-y-2">
          <p className="font-bold text-green-700">{result.message}</p>
          {result.blindMode && (
            <p className="text-xs text-purple-600 font-medium">
              Blind Mode 투표 — 서버는 평문 후보를 보지 못했습니다
            </p>
          )}
          {panicCredential && (
            <p className="text-xs text-red-600 font-medium">
              Panic Credential 투표 — 이 투표는 집계에서 자동 제외됩니다 (PAPER-12)
            </p>
          )}
          {result.nullifierHash && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Nullifier Hash (E2E 검증에 사용):</p>
              <code className="text-xs bg-white border rounded px-2 py-1 block break-all">
                {result.nullifierHash}
              </code>
              <p className="text-xs text-gray-400 mt-1">
                이 값을 저장해두면 검증 탭에서 투표 포함 여부를 확인할 수 있습니다.
                <br/>재투표 시 최종 1표만 유효합니다 (이전 투표는 자동 대체).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
