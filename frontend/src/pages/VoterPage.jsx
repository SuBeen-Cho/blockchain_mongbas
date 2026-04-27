/**
 * VoterPage.jsx — 유권자 투표 UI (Idemix 자격증명 연동)
 *
 * 핵심 프라이버시 원칙:
 *   - voterSecret은 이 컴포넌트에서만 생성·보관, 절대 서버 전송 안 함
 *   - nullifierHash = SHA256(voterSecret + electionID) — 브라우저에서 계산
 *   - Idemix credential: 서버에서 발급, voterID 미포함 → 익명 자격 증명
 *   - 강압 상황을 위한 Panic Password 지원
 */

import { useState, useEffect, useRef } from 'react';
import { computeNullifier, computePasswordHash, generateVoterSecret } from '../utils/crypto.js';

const API = '/api';

export default function VoterPage() {
  // ── 선거 조회 ───────────────────────────────────────
  const [electionID, setElectionID] = useState('');
  const [election,   setElection]   = useState(null);

  // ── Idemix 자격증명 ────────────────────────────────
  const [enrollmentID,     setEnrollmentID]     = useState('voter1');
  const [enrollmentSecret, setEnrollmentSecret] = useState('voter1pw');
  const [idemixCredential, setIdemixCredential] = useState('');
  const [credStatus,       setCredStatus]       = useState('');  // 'fetching' | 'ok' | 'error' | ''

  // ── 투표 입력 ───────────────────────────────────────
  const [voterSecret,    setVoterSecret]    = useState('');
  const [candidateID,    setCandidateID]    = useState('');
  const [normalPassword, setNormalPassword] = useState('');
  const [panicPassword,  setPanicPassword]  = useState('');
  const [panicCandidate, setPanicCandidate] = useState('');

  // ── UI 상태 ─────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState('');
  const [panicMode, setPanicMode] = useState(false);

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
    setLoading(true); setError(''); setResult(null);
    try {
      // [CRIT-03 FIX] 블라인딩 팩터 조회 후 nullifier 계산
      // 변경 전: SHA256(voterSecret + electionID) — 결정론적, 선거 간 연결 가능
      // 변경 후: SHA256(voterSecret + electionID + blindingFactor) — 선거별 salt
      const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
      if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
      const { blindingFactor } = await bfRes.json();
      const nullifierHash = await computeNullifier(voterSecret, electionID, blindingFactor);

      const body = { electionID, candidateID, nullifierHash };

      if (normalPassword && panicPassword) {
        body.normalPWHash     = await computePasswordHash(normalPassword, nullifierHash);
        body.panicPWHash      = await computePasswordHash(panicPassword,  nullifierHash);
        body.panicCandidateID = panicCandidate || candidateID;
      }

      // Idemix credential 헤더 첨부 (사전 발급된 credential 재사용 → 체감 지연 0)
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
      setResult({ nullifierHash, ...data });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
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
        {credStatus === 'ok'       && <p className="text-xs text-green-600">✅ Idemix 자격증명 발급 완료 (익명 자격 확인됨)</p>}
        {credStatus === 'fetching' && <p className="text-xs text-blue-500">⏳ 자격증명 발급 중...</p>}
        {credStatus === 'error'    && <p className="text-xs text-red-500">❌ 자격증명 발급 실패 — 유권자 ID/비밀번호 확인</p>}
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
                {loading ? '처리 중...' : '투표 제출'}
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
          {result.nullifierHash && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Nullifier Hash (E2E 검증에 사용):</p>
              <code className="text-xs bg-white border rounded px-2 py-1 block break-all">
                {result.nullifierHash}
              </code>
              <p className="text-xs text-gray-400 mt-1">이 값을 저장해두면 검증 탭에서 투표 포함 여부를 확인할 수 있습니다.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
