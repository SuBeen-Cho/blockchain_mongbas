/**
 * VerifyPage.jsx — E2E 검증 (Merkle 포함 증명 + 공개 검증)
 *
 * 유권자가 자신의 투표가 집계에 포함됐는지 독립적으로 검증합니다.
 * Deniable Verification: 비밀번호에 따라 Normal/Panic 경로 분기.
 * [PAPER-6] Bulletin Board: 누구나 공개된 키로 전체 집계를 독립 검증.
 * [PAPER-8] Receipt-Free: 증명 데이터 없이 포함 여부만 확인.
 */

import { useState } from 'react';
import { computeMerkleRootFromProof, computeNullifier, computePasswordHash, verifyBulletinBoard } from '../utils/crypto.js';

const API = '/api';

export default function VerifyPage() {
  const [electionID,   setElectionID]   = useState('');
  const [voterSecret,  setVoterSecret]  = useState('');
  const [nullifierHash, setNullifierHash] = useState('');
  const [password,     setPassword]     = useState('');
  const [mode,         setMode]         = useState('simple'); // 'simple' | 'deniable' | 'bulletin' | 'receipt-free'

  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState('');

  // [PAPER-6] Bulletin Board
  const [bbResult, setBbResult] = useState(null);
  // [PAPER-8] Receipt-free
  const [rfResult, setRfResult] = useState(null);

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

      const proofPayload = data.proof && !Array.isArray(data.proof) ? data.proof : data;
      const proofPath = Array.isArray(data.proof)
        ? data.proof
        : Array.isArray(data.proof?.proof)
          ? data.proof.proof
          : [];
      const leafHash = proofPayload.leafHash || data.leafHash || '';

      const rootRes = await fetch(`${API}/elections/${electionID}/merkle`);
      const rootData = await rootRes.json();
      if (!rootRes.ok) throw new Error(rootData.error || 'Merkle root 조회 실패');

      const computedRoot = await computeMerkleRootFromProof(leafHash, proofPath);
      const chainRoot = rootData.rootHash;
      const localVerified = computedRoot === chainRoot;
      if (!localVerified) {
        throw new Error('로컬 Merkle proof 검증 실패: 재계산한 root가 체인 root와 일치하지 않습니다.');
      }

      setResult({
        nullifierHash: hash,
        ...data,
        localVerification: {
          ok: localVerified,
          computedRoot,
          chainRoot,
          leafHash,
        },
      });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  // [PAPER-6] Bulletin Board 공개 검증
  async function verifyBulletinBoardPublic() {
    setLoading(true); setError(''); setBbResult(null);
    try {
      // 1. Bulletin Board 데이터 조회
      const bbRes = await fetch(`${API}/elections/${electionID}/bulletin-board`);
      const bbData = await bbRes.json();
      if (!bbRes.ok) throw new Error(bbData.error || 'Bulletin Board 조회 실패');

      // 2. 브라우저에서 독립 검증 (공개 키로 복호화 + 재집계)
      const verification = await verifyBulletinBoard(bbData);

      // 3. 서버 측 검증도 수행
      const serverRes = await fetch(`${API}/elections/${electionID}/verify-public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electionID }),
      });
      const serverData = await serverRes.json();

      setBbResult({
        clientVerification: verification,
        serverVerification: serverData,
        bulletinBoard: {
          totalBallots: bbData.encryptedBallots?.length || 0,
          tallyResults: bbData.tallyResults,
          publishedAt: bbData.publishedAt,
          hasShuffleProof: !!bbData.shuffleProofHash,
        },
      });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  // [PAPER-8] Receipt-Free 검증
  async function verifyReceiptFree() {
    setLoading(true); setError(''); setRfResult(null);
    try {
      let hash = nullifierHash;
      if (!hash && voterSecret && electionID) {
        const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
        if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
        const { blindingFactor } = await bfRes.json();
        hash = await computeNullifier(voterSecret, electionID, blindingFactor);
        setNullifierHash(hash);
      }
      if (!hash) throw new Error('nullifierHash 또는 voterSecret이 필요합니다.');

      const res = await fetch(`${API}/elections/${electionID}/vote-counted/${hash}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '확인 실패');
      setRfResult(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="space-y-5">
      <section className="bg-white rounded-xl shadow p-5 space-y-4">
        <h2 className="font-bold text-gray-700">E2E 검증</h2>
        <p className="text-xs text-gray-500">
          투표 포함 여부 확인, 공개 집계 검증, Receipt-free 확인 등 다양한 검증 모드를 제공합니다.
        </p>

        <input
          className="border rounded px-3 py-2 w-full text-sm"
          placeholder="선거 ID"
          value={electionID}
          onChange={e => setElectionID(e.target.value)}
        />

        <div className="flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="simple"   checked={mode==='simple'}   onChange={() => { setMode('simple'); setResult(null); setBbResult(null); setRfResult(null); }} />
            Merkle 검증
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="deniable" checked={mode==='deniable'} onChange={() => { setMode('deniable'); setResult(null); setBbResult(null); setRfResult(null); }} />
            Deniable
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="bulletin" checked={mode==='bulletin'} onChange={() => { setMode('bulletin'); setResult(null); setBbResult(null); setRfResult(null); }} />
            Bulletin Board (PAPER-6)
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="receipt-free" checked={mode==='receipt-free'} onChange={() => { setMode('receipt-free'); setResult(null); setBbResult(null); setRfResult(null); }} />
            Receipt-Free (PAPER-8)
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

        {mode === 'bulletin' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              선거 종료 후 공개된 암호화 키로 모든 투표를 복호화하고 재집계하여 결과를 독립 검증합니다.
              <br/>인증 불필요 — 누구나 검증 가능 (Universal Verifiability).
            </p>
          </div>
        )}

        {mode === 'receipt-free' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              투표 포함 여부만 확인합니다. 후보자 정보, Merkle proof 등 증명 데이터가 반환되지 않아
              강압자에게 보여줄 receipt가 생성되지 않습니다.
            </p>
            <div className="flex gap-2">
              <input
                className="border rounded px-3 py-2 flex-1 text-sm font-mono"
                placeholder="voterSecret"
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

        <button
          className={`w-full py-3 rounded-lg font-bold text-white text-sm ${
            loading ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
          }`}
          onClick={
            mode === 'bulletin' ? verifyBulletinBoardPublic :
            mode === 'receipt-free' ? verifyReceiptFree :
            verify
          }
          disabled={loading}
        >
          {loading ? '검증 중...' :
           mode === 'bulletin' ? '공개 검증 (Bulletin Board)' :
           mode === 'receipt-free' ? 'Receipt-Free 확인' :
           '검증하기'}
        </button>
      </section>

      {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>}

      {/* Merkle / Deniable 결과 */}
      {result && (
        <section className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-3">
          <p className="font-bold text-green-700">검증 성공 — 투표가 집계에 포함됨</p>
          {result.localVerification?.ok && (
            <p className="text-xs text-green-700">
              브라우저에서 Merkle proof를 재계산했고, 체인에 기록된 Root Hash와 일치합니다.
            </p>
          )}
          <div className="text-xs space-y-1">
            <p><span className="font-medium">선거:</span> {result.electionID}</p>
            <p><span className="font-medium">Nullifier:</span></p>
            <code className="block bg-white border rounded px-2 py-1 break-all">{result.nullifierHash}</code>
            {(result.leafHash || result.proof?.leafHash) && (
              <>
                <p><span className="font-medium">Merkle Leaf:</span></p>
                <code className="block bg-white border rounded px-2 py-1 break-all">
                  {result.leafHash || result.proof.leafHash}
                </code>
              </>
            )}
            {result.localVerification?.chainRoot && (
              <>
                <p><span className="font-medium">Chain Root:</span></p>
                <code className="block bg-white border rounded px-2 py-1 break-all">
                  {result.localVerification.chainRoot}
                </code>
              </>
            )}
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

      {/* [PAPER-6] Bulletin Board 결과 */}
      {bbResult && (
        <section className={`border rounded-xl p-5 space-y-3 ${
          bbResult.clientVerification.verified ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
        }`}>
          <p className={`font-bold ${bbResult.clientVerification.verified ? 'text-green-700' : 'text-red-700'}`}>
            {bbResult.clientVerification.verified
              ? 'Universal Verification 성공 — 집계 결과가 정확합니다'
              : 'Universal Verification 실패 — 집계 불일치 감지'}
          </p>
          <div className="text-xs space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white border rounded p-2">
                <p className="font-medium text-gray-600 mb-1">브라우저 검증 (Client)</p>
                <p>재집계 일치: <span className={bbResult.clientVerification.tallyVerification?.tallyMatch ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                  {bbResult.clientVerification.tallyVerification?.tallyMatch ? 'YES' : 'NO'}
                </span></p>
                <p>검증된 투표: {bbResult.clientVerification.tallyVerification?.validCount}/{bbResult.clientVerification.tallyVerification?.totalCount}</p>
                <p>모든 투표 증명 존재: {bbResult.clientVerification.allBallotsHaveProof ? 'YES' : 'NO'}</p>
              </div>
              <div className="bg-white border rounded p-2">
                <p className="font-medium text-gray-600 mb-1">서버 검증 (Chaincode)</p>
                <p>결과 일치: <span className={bbResult.serverVerification?.resultsMatch ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                  {bbResult.serverVerification?.resultsMatch ? 'YES' : 'NO'}
                </span></p>
                <p>Proof Hash 일치: {bbResult.serverVerification?.proofHashMatch ? 'YES' : 'NO'}</p>
                {bbResult.bulletinBoard.hasShuffleProof && (
                  <p>Shuffle 검증: {bbResult.serverVerification?.shuffleVerified ? 'YES' : 'NO'}</p>
                )}
              </div>
            </div>
            <div className="bg-white border rounded p-2">
              <p className="font-medium text-gray-600 mb-1">집계 결과</p>
              {bbResult.bulletinBoard.tallyResults && Object.entries(bbResult.bulletinBoard.tallyResults)
                .sort(([,a],[,b]) => b - a)
                .map(([candidate, count]) => (
                  <p key={candidate}>{candidate}: <span className="font-bold">{count}표</span></p>
                ))
              }
              <p className="text-gray-500 mt-1">총 {bbResult.bulletinBoard.totalBallots}표</p>
            </div>
          </div>
        </section>
      )}

      {/* [PAPER-8] Receipt-Free 결과 */}
      {rfResult && (
        <section className={`border rounded-xl p-5 space-y-2 ${
          rfResult.included ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
        }`}>
          <p className={`font-bold ${rfResult.included ? 'text-green-700' : 'text-yellow-700'}`}>
            {rfResult.included
              ? 'Receipt-Free 확인: 투표가 집계에 포함되어 있습니다'
              : 'Receipt-Free 확인: 해당 투표가 발견되지 않습니다'}
          </p>
          <p className="text-xs text-gray-500">
            총 투표수: {rfResult.totalVotes}표
          </p>
          <p className="text-xs text-gray-400">
            후보자 정보, Merkle proof 등 증명 데이터는 반환되지 않습니다 — receipt 생성 불가
          </p>
        </section>
      )}
    </div>
  );
}
