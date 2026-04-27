/**
 * VerifyPage.jsx — E2E 검증 (Merkle 포함 증명)
 *
 * 유권자가 자신의 투표가 집계에 포함됐는지 독립적으로 검증합니다.
 * Deniable Verification: 비밀번호에 따라 Normal/Panic 경로 분기.
 */

import { useState } from 'react';
import { computeNullifier, computePasswordHash } from '../utils/crypto.js';

const API = '/api';

export default function VerifyPage() {
  const [electionID,   setElectionID]   = useState('');
  const [voterSecret,  setVoterSecret]  = useState('');
  const [nullifierHash, setNullifierHash] = useState('');
  const [password,     setPassword]     = useState('');
  const [mode,         setMode]         = useState('simple'); // 'simple' | 'deniable'

  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState('');

  async function verify() {
    setLoading(true); setError(''); setResult(null);
    try {
      let hash = nullifierHash;

      // voterSecret이 있으면 직접 계산
      // [CRIT-03 FIX] 블라인딩 팩터 포함하여 계산
      if (!hash && voterSecret && electionID) {
        const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
        if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
        const { blindingFactor } = await bfRes.json();
        hash = await computeNullifier(voterSecret, electionID, blindingFactor);
        setNullifierHash(hash);
      }
      if (!hash) throw new Error('nullifierHash 또는 (voterSecret + electionID)가 필요합니다.');

      let res, data;

      if (mode === 'deniable' && password) {
        // Deniable Verification (Normal/Panic 분기)
        const pwHash = await computePasswordHash(password, hash);
        res  = await fetch(`${API}/elections/${electionID}/proof`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ nullifierHash: hash, passwordHash: pwHash }),
        });
      } else {
        // 일반 Merkle 포함 증명
        res = await fetch(`${API}/elections/${electionID}/proof/${hash}`);
      }

      data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult({ nullifierHash: hash, ...data });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-xl shadow p-5 space-y-4">
        <h2 className="font-bold text-gray-700">E2E 검증 — Merkle 포함 증명</h2>
        <p className="text-xs text-gray-500">
          내 투표가 집계에 포함됐는지 블록체인 Merkle Tree로 독립 검증합니다.
          서버를 신뢰할 필요 없이 수학적으로 증명합니다.
        </p>

        <input
          className="border rounded px-3 py-2 w-full text-sm"
          placeholder="선거 ID"
          value={electionID}
          onChange={e => setElectionID(e.target.value)}
        />

        <div className="flex gap-3 text-sm">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="simple"   checked={mode==='simple'}   onChange={() => setMode('simple')} />
            Nullifier로 검증
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="deniable" checked={mode==='deniable'} onChange={() => setMode('deniable')} />
            Deniable Verification
          </label>
        </div>

        {mode === 'simple' && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                className="border rounded px-3 py-2 flex-1 text-sm font-mono"
                placeholder="voterSecret (알고 있는 경우)"
                value={voterSecret}
                onChange={e => setVoterSecret(e.target.value)}
              />
              <span className="self-center text-gray-400 text-xs">또는</span>
            </div>
            <input
              className="border rounded px-3 py-2 w-full text-sm font-mono"
              placeholder="nullifierHash (직접 입력)"
              value={nullifierHash}
              onChange={e => setNullifierHash(e.target.value)}
            />
          </div>
        )}

        {mode === 'deniable' && (
          <div className="space-y-2">
            <input
              className="border rounded px-3 py-2 w-full text-sm font-mono"
              placeholder="voterSecret"
              value={voterSecret}
              onChange={e => setVoterSecret(e.target.value)}
            />
            <input
              className="border rounded px-3 py-2 w-full text-sm"
              placeholder="비밀번호 (Normal 또는 Panic)"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <p className="text-xs text-gray-400">
              Normal 비밀번호 → 실제 투표 증명 반환<br/>
              Panic 비밀번호 → 가짜 투표 증명 반환 (강압 대응)
            </p>
          </div>
        )}

        <button
          className={`w-full py-3 rounded-lg font-bold text-white text-sm ${
            loading ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
          }`}
          onClick={verify}
          disabled={loading}
        >
          {loading ? '검증 중...' : '검증하기'}
        </button>
      </section>

      {error  && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>}

      {result && (
        <section className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-3">
          <p className="font-bold text-green-700">✅ 검증 성공 — 투표가 집계에 포함됨</p>
          <div className="text-xs space-y-1">
            <p><span className="font-medium">선거:</span> {result.electionID}</p>
            <p><span className="font-medium">Nullifier:</span></p>
            <code className="block bg-white border rounded px-2 py-1 break-all">{result.nullifierHash}</code>
          </div>
          {result.proof && (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium text-gray-600">Merkle Proof 상세 보기</summary>
              <pre className="mt-2 bg-white border rounded p-2 overflow-auto text-xs">
                {JSON.stringify(result.proof, null, 2)}
              </pre>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
