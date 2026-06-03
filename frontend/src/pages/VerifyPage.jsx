/**
 * VerifyPage.jsx — E2E 검증 (아이콘 카드 방식)
 */

import { useState, useRef, useEffect } from 'react';
import { computeMerkleRootFromProof, computeNullifier, computePasswordHash, verifyBulletinBoard, verifyChaumPedersen } from '../utils/crypto.js';
import HashDisplay from '../components/HashDisplay.jsx';
import Alert from '../components/Alert.jsx';
import MerkleTreeDiagram from '../components/verify-animations/MerkleTreeDiagram.jsx';
import DeniableDiagram from '../components/verify-animations/DeniableDiagram.jsx';
import BulletinBoardPipeline from '../components/verify-animations/BulletinBoardPipeline.jsx';
import ReceiptFreeDiagram from '../components/verify-animations/ReceiptFreeDiagram.jsx';
import ElGamalZKPDiagram from '../components/verify-animations/ElGamalZKPDiagram.jsx';

const API = '/api';

const MODES = [
  { id: 'simple',       label: 'Merkle 검증',     desc: '투표 포함 증명',           icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z' },
  { id: 'deniable',     label: 'Deniable',        desc: '강압 대응 검증',           icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z' },
  { id: 'bulletin',     label: 'Bulletin Board',  desc: '공개 재집계 검증',         icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
  { id: 'receipt-free', label: 'Receipt-Free',    desc: '포함 여부만 확인',         icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'elgamal-zkp',  label: 'ElGamal ZKP',     desc: '영지식 증명 검증',         icon: 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z' },
];

export default function VerifyPage() {
  const [electionID,    setElectionID]    = useState('');
  const [voterSecret,   setVoterSecret]   = useState('');
  const [nullifierHash, setNullifierHash] = useState('');
  const [password,      setPassword]      = useState('');
  const [mode,          setMode]          = useState('simple');

  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [prevDeniableResult, setPrevDeniableResult] = useState(null);
  const [error,   setError]   = useState('');
  const [bbResult,  setBbResult]  = useState(null);
  const [rfResult,  setRfResult]  = useState(null);
  const [zkpResult, setZkpResult] = useState(null);
  const [verifySteps, setVerifySteps] = useState([]);
  const animRef = useRef(null);

  // 검증 시작 시 애니메이션 영역으로 자동 스크롤
  useEffect(() => {
    if (verifySteps.length === 1 && animRef.current) {
      animRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [verifySteps]);

  function resetResults() {
    setResult(null); setPrevDeniableResult(null); setBbResult(null); setRfResult(null); setZkpResult(null); setError('');
  }

  async function verify() {
    if (!electionID) return setError('선거 ID를 입력하세요.');
    setLoading(true); setError(''); setVerifySteps([]);
    if (mode === 'deniable' && result) setPrevDeniableResult(result);
    setResult(null);
    try {
      // Step 1: Nullifier 조회
      setVerifySteps(['nullifier']);
      let hash = nullifierHash;
      if (!hash && voterSecret && electionID) {
        const bfRes = await fetch(`${API}/elections/${electionID}/blinding-factor`);
        if (!bfRes.ok) throw new Error('블라인딩 팩터 조회 실패');
        const { blindingFactor } = await bfRes.json();
        hash = await computeNullifier(voterSecret, electionID, blindingFactor);
        setNullifierHash(hash);
      }
      if (!hash) throw new Error('nullifierHash 또는 (voterSecret + electionID)가 필요합니다.');
      setVerifySteps(s => [...s, 'nullifier_done']);

      // Step 2: Merkle Proof 수신
      setVerifySteps(s => [...s, 'proof']);
      let res, data;
      if (mode === 'deniable' && password) {
        const pwHash = await computePasswordHash(password, hash);
        res = await fetch(`${API}/elections/${electionID}/proof`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nullifierHash: hash, passwordHash: pwHash }),
        });
      } else {
        res = await fetch(`${API}/elections/${electionID}/proof/${hash}`);
      }
      data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setVerifySteps(s => [...s, 'proof_done']);

      const proofPayload = data.proof && !Array.isArray(data.proof) ? data.proof : data;
      const proofPath = Array.isArray(data.proof) ? data.proof : Array.isArray(data.proof?.proof) ? data.proof.proof : [];
      const leafHash = proofPayload.leafHash || data.leafHash || '';

      // Step 3: Root 재계산
      setVerifySteps(s => [...s, 'compute']);
      const rootRes = await fetch(`${API}/elections/${electionID}/merkle`);
      const rootData = await rootRes.json();
      if (!rootRes.ok) throw new Error(rootData.error || 'Merkle root 조회 실패');
      const computedRoot = await computeMerkleRootFromProof(leafHash, proofPath);
      setVerifySteps(s => [...s, 'compute_done']);

      // Step 4: Chain Root 비교
      setVerifySteps(s => [...s, 'compare']);
      const chainRoot = rootData.rootHash;
      const localVerified = computedRoot === chainRoot;
      if (!localVerified) throw new Error('Merkle proof 검증 실패: root 불일치');
      setVerifySteps(s => [...s, 'compare_done']);

      setResult({
        nullifierHash: hash, ...data,
        localVerification: { ok: localVerified, computedRoot, chainRoot, leafHash },
      });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function verifyBulletinBoardPublic() {
    if (!electionID) return setError('선거 ID를 입력하세요.');
    setLoading(true); setError(''); setBbResult(null); setVerifySteps([]);
    try {
      setVerifySteps(['bb_fetch']);
      const bbRes = await fetch(`${API}/elections/${electionID}/bulletin-board`);
      const bbData = await bbRes.json();
      if (!bbRes.ok) throw new Error(bbData.error || 'Bulletin Board 조회 실패');
      setVerifySteps(s => [...s, 'bb_fetch_done', 'bb_decrypt']);

      const verification = await verifyBulletinBoard(bbData);
      setVerifySteps(s => [...s, 'bb_decrypt_done', 'bb_server']);

      const serverRes = await fetch(`${API}/elections/${electionID}/verify-public`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electionID }),
      });
      const serverData = await serverRes.json();
      setVerifySteps(s => [...s, 'bb_server_done', 'bb_compare']);
      setVerifySteps(s => [...s, 'bb_compare_done']);

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

  async function verifyElGamalZKP() {
    if (!electionID) return setError('선거 ID를 입력하세요.');
    setLoading(true); setError(''); setZkpResult(null); setVerifySteps([]);
    try {
      setVerifySteps(['zkp_fetch']);
      const res = await fetch(`${API}/elections/${electionID}/verify-elgamal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electionID }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ZKP 검증 실패');
      setVerifySteps(s => [...s, 'zkp_fetch_done', 'zkp_verify', 'zkp_verify_done', 'zkp_compare', 'zkp_compare_done']);
      setZkpResult(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function verifyReceiptFree() {
    if (!electionID) return setError('선거 ID를 입력하세요.');
    setLoading(true); setError(''); setRfResult(null); setVerifySteps([]);
    try {
      setVerifySteps(['rf_query']);
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

  const handleVerify = mode === 'bulletin' ? verifyBulletinBoardPublic
    : mode === 'receipt-free' ? verifyReceiptFree
    : mode === 'elgamal-zkp' ? verifyElGamalZKP
    : verify;

  const btnLabel = mode === 'bulletin' ? '공개 검증 시작'
    : mode === 'receipt-free' ? 'Receipt-Free 확인'
    : mode === 'elgamal-zkp' ? 'ZKP 검증 시작'
    : '검증하기';

  return (
    <div className="space-y-8">
      {/* 페이지 헤더 */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">E2E 검증</h1>
        <p className="text-sm text-slate-500 mt-1">투표 포함 여부 확인, 공개 집계 검증, Receipt-free 확인 등 다양한 검증 모드를 제공합니다.</p>
      </div>

      {/* 선거 ID 입력 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <label className="block text-sm font-medium text-slate-700 mb-1.5">선거 ID</label>
        <input
          className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm font-mono bg-white
            focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
          placeholder="예: ELECTION_2026_PRESIDENT"
          value={electionID}
          onChange={e => setElectionID(e.target.value)}
        />
      </div>

      {/* 검증 방식 선택 — 아이콘 카드 */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-3">검증 방식</h3>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); resetResults(); }}
              className={`
                flex flex-col items-center gap-2 p-4 rounded-xl border-2 text-center
                transition-all duration-200
                ${mode === m.id
                  ? 'border-blue-500 bg-blue-50 shadow-sm'
                  : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/30'
                }
              `}
            >
              <svg className={`w-6 h-6 ${mode === m.id ? 'text-blue-600' : 'text-slate-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={m.icon} />
              </svg>
              <span className={`text-xs font-semibold ${mode === m.id ? 'text-blue-700' : 'text-slate-700'}`}>{m.label}</span>
              <span className="text-[10px] text-slate-500 leading-tight">{m.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 입력 폼 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        {(mode === 'simple' || mode === 'receipt-free') && (
          <>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">voterSecret</label>
              <input
                className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm font-mono bg-white
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="투표 시 사용한 voterSecret"
                value={voterSecret}
                onChange={e => setVoterSecret(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-xs text-slate-400">또는</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">nullifierHash (직접 입력)</label>
              <input
                className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm font-mono bg-white
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="투표 완료 시 받은 추적 번호"
                value={nullifierHash}
                onChange={e => setNullifierHash(e.target.value)}
              />
            </div>
          </>
        )}

        {mode === 'deniable' && (
          <>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">voterSecret</label>
              <input
                className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm font-mono bg-white
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="voterSecret"
                value={voterSecret}
                onChange={e => setVoterSecret(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">비밀번호</label>
              <input
                className="w-full h-11 px-4 border border-slate-200 rounded-lg text-sm bg-white
                  focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200"
                placeholder="Normal 또는 Panic 비밀번호"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
            <p className="text-xs text-slate-400">Normal 비밀번호 → 실제 투표 증명 / Panic 비밀번호 → 가짜 증명 (강압 대응)</p>
          </>
        )}

        {mode === 'bulletin' && (
          <Alert variant="info">
            선거 종료 후 공개된 암호화 키로 모든 투표를 복호화하고 재집계합니다. 인증 불필요 — 누구나 검증 가능.
          </Alert>
        )}

        {mode === 'elgamal-zkp' && (
          <Alert variant="purple">
            ElGamal 모드에서 Chaum-Pedersen ZKP로 비밀키 없이 복호화 정확성을 수학적으로 증명합니다.
          </Alert>
        )}

        {mode === 'receipt-free' && (
          <Alert variant="warning">
            포함 여부만 확인합니다. 후보자 정보나 증명 데이터가 반환되지 않아 receipt 생성이 불가합니다.
          </Alert>
        )}

        <button
          onClick={handleVerify}
          disabled={loading}
          className={`
            w-full h-12 rounded-xl font-bold text-white text-sm
            transition-all duration-200 active:scale-[0.99] shadow-sm
            ${loading ? 'bg-slate-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-600/20'}
          `}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              검증 중...
            </span>
          ) : btnLabel}
        </button>
      </div>

      {/* 에러 */}
      {error && <Alert variant="error">{error}</Alert>}

      {/* ── 검증 흐름 애니메이션 ── */}
      <div ref={animRef}>
        {(loading || verifySteps.length > 0) && (mode === 'simple' || mode === 'deniable') && (
          mode === 'deniable'
            ? <DeniableDiagram verifySteps={verifySteps} result={result} prevResult={prevDeniableResult} />
            : <MerkleTreeDiagram verifySteps={verifySteps} result={result} />
        )}
        {(loading || verifySteps.length > 0) && mode === 'bulletin' && (
          <BulletinBoardPipeline verifySteps={verifySteps} result={bbResult} />
        )}
        {(loading || verifySteps.length > 0) && mode === 'receipt-free' && (
          <ReceiptFreeDiagram verifySteps={verifySteps} result={rfResult} />
        )}
        {(loading || verifySteps.length > 0) && mode === 'elgamal-zkp' && (
          <ElGamalZKPDiagram verifySteps={verifySteps} result={zkpResult} />
        )}
      </div>

      {/* ── Merkle / Deniable 결과 ── */}
      {result && (
        <div className="bg-white rounded-2xl border border-emerald-200 shadow-sm">
          <div className="bg-emerald-50 px-6 py-4 border-b border-emerald-200 flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-bold text-emerald-800">검증 성공</p>
              <p className="text-xs text-emerald-600">투표가 집계에 포함됨 — Merkle proof 검증 완료
                {mode === 'deniable'
                  ? <span className="ml-2 px-1.5 py-0.5 bg-red-200/60 text-red-800 rounded text-[10px] font-bold">Coercion Resistance</span>
                  : <span className="ml-2 px-1.5 py-0.5 bg-emerald-200/60 text-emerald-800 rounded text-[10px] font-bold">Recorded-as-Cast</span>
                }
              </p>
            </div>
          </div>
          <div className="p-6 space-y-4">
            <HashDisplay label="Nullifier Hash" value={result.nullifierHash} />
            {(result.leafHash || result.proof?.leafHash) && (
              <HashDisplay label="Merkle Leaf Hash" value={result.leafHash || result.proof?.leafHash} />
            )}
            {result.localVerification?.chainRoot && (
              <HashDisplay label="Chain Root Hash (블록체인 저장)" value={result.localVerification.chainRoot} />
            )}
            {result.localVerification?.computedRoot && result.localVerification.computedRoot === result.localVerification.chainRoot && (
              <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-200">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                <span>직접 계산한 Root = 블록체인 Root → <span className="font-bold">투표가 변조 없이 포함되어 있음을 증명</span></span>
              </div>
            )}
            {result.proof && (
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-slate-500 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-1 transition-colors">
                  Merkle Proof 상세 보기
                </summary>
                <pre className="mt-2 bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-auto font-mono text-xs">
                  {JSON.stringify(result.proof, null, 2)}
                </pre>
              </details>
            )}

            {/* Deniable 비교 패널 */}
            {mode === 'deniable' && prevDeniableResult && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
                <p className="text-xs font-semibold text-amber-800">이전 검증 결과와 비교</p>
                <div className="grid grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <p className="font-semibold text-slate-500 mb-1">이전 (다른 비밀번호)</p>
                    <p className="font-mono text-slate-600 break-all">{prevDeniableResult.localVerification?.leafHash || prevDeniableResult.proof?.leafHash || prevDeniableResult.leafHash || '-'}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-slate-500 mb-1">현재</p>
                    <p className="font-mono text-slate-600 break-all">{result.localVerification?.leafHash || result.proof?.leafHash || result.leafHash || '-'}</p>
                  </div>
                </div>
                <p className="text-[11px] text-amber-700 font-medium">
                  두 결과 모두 "검증 성공"이지만 Leaf Hash가 다름 — 강압자가 어느 것이 진짜인지 구분할 수 없습니다 (Coercion Resistance)
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Bulletin Board 결과 ── */}
      {bbResult && (
        <div className={`bg-white rounded-2xl border shadow-sm ${
          bbResult.clientVerification.verified ? 'border-emerald-200' : 'border-red-200'
        }`}>
          <div className={`px-6 py-4 border-b flex items-center gap-3 ${
            bbResult.clientVerification.verified ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'
          }`}>
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
              bbResult.clientVerification.verified ? 'bg-emerald-100' : 'bg-red-100'
            }`}>
              {bbResult.clientVerification.verified ? (
                <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              )}
            </div>
            <div>
              <p className={`font-bold ${bbResult.clientVerification.verified ? 'text-emerald-800' : 'text-red-800'}`}>
                Universal Verification {bbResult.clientVerification.verified ? '성공' : '실패'}
              </p>
              <p className="text-xs text-slate-500">클라이언트 + 서버 이중 검증
                <span className="ml-2 px-1.5 py-0.5 bg-blue-200/60 text-blue-800 rounded text-[10px] font-bold">Universal Verifiability</span>
              </p>
            </div>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">브라우저 검증</p>
                <VerifyItem label="재집계 일치" ok={bbResult.clientVerification.tallyVerification?.tallyMatch} />
                <p className="text-xs text-slate-600">
                  검증된 투표: {bbResult.clientVerification.tallyVerification?.validCount}/{bbResult.clientVerification.tallyVerification?.totalCount}
                </p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">서버 검증</p>
                <VerifyItem label="결과 일치" ok={bbResult.serverVerification?.resultsMatch} />
                <VerifyItem label="Proof Hash" ok={bbResult.serverVerification?.proofHashMatch} />
                {bbResult.bulletinBoard.hasShuffleProof && (
                  <VerifyItem label="Shuffle" ok={bbResult.serverVerification?.shuffleVerified} />
                )}
              </div>
            </div>
            {bbResult.bulletinBoard.tallyResults && (
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">집계 결과</p>
                {Object.entries(bbResult.bulletinBoard.tallyResults).sort(([,a],[,b]) => b - a).map(([c, n]) => (
                  <p key={c} className="text-sm"><span className="font-semibold">{c}</span>: <span className="font-mono">{n}표</span></p>
                ))}
                <p className="text-xs text-slate-400 mt-2">총 {Object.values(bbResult.bulletinBoard.tallyResults).reduce((a,b) => a+b, 0)}표</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ElGamal ZKP 결과 ── */}
      {zkpResult && (
        <div className={`bg-white rounded-2xl border shadow-sm ${zkpResult.isValid ? 'border-emerald-200' : 'border-red-200'}`}>
          <div className={`px-6 py-4 border-b flex items-center gap-3 ${zkpResult.isValid ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${zkpResult.isValid ? 'bg-emerald-100' : 'bg-red-100'}`}>
              <svg className={`w-5 h-5 ${zkpResult.isValid ? 'text-emerald-600' : 'text-red-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={zkpResult.isValid ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12'} />
              </svg>
            </div>
            <div>
              <p className={`font-bold ${zkpResult.isValid ? 'text-emerald-800' : 'text-red-800'}`}>
                Chaum-Pedersen ZKP {zkpResult.isValid ? '검증 성공' : '검증 실패'}
              </p>
              <p className="text-xs text-slate-500">비밀키 없이 복호화 정확성 증명
                <span className="ml-2 px-1.5 py-0.5 bg-purple-200/60 text-purple-800 rounded text-[10px] font-bold">Tallied-as-Recorded</span>
              </p>
            </div>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-slate-50 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-emerald-600">{zkpResult.verified}</p>
                <p className="text-xs text-slate-500 mt-1">검증 성공</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4 text-center">
                <p className={`text-2xl font-bold ${zkpResult.failed > 0 ? 'text-red-600' : 'text-slate-400'}`}>{zkpResult.failed}</p>
                <p className="text-xs text-slate-500 mt-1">실패</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-4 text-center">
                <VerifyItem label="재집계 일치" ok={zkpResult.resultsMatch} />
              </div>
            </div>
            {zkpResult.recount && (
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">집계 결과 (ZKP 검증됨)</p>
                {Object.entries(zkpResult.recount).sort(([,a],[,b]) => b - a).map(([c, n]) => (
                  <p key={c} className="text-sm"><span className="font-semibold">{c}</span>: <span className="font-mono">{n}표</span></p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Receipt-Free 결과 ── */}
      {rfResult && (
        <div className={`bg-white rounded-2xl border shadow-sm ${rfResult.included ? 'border-emerald-200' : 'border-amber-200'}`}>
          <div className={`px-6 py-4 border-b flex items-center gap-3 ${rfResult.included ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${rfResult.included ? 'bg-emerald-100' : 'bg-amber-100'}`}>
              {rfResult.included ? (
                <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01" /></svg>
              )}
            </div>
            <div>
              <p className={`font-bold ${rfResult.included ? 'text-emerald-800' : 'text-amber-800'}`}>
                {rfResult.included ? '투표가 집계에 포함되어 있습니다' : '해당 투표가 발견되지 않습니다'}
              </p>
              <p className="text-xs text-slate-500">총 투표수: {rfResult.totalVotes}표
                <span className="ml-2 px-1.5 py-0.5 bg-amber-200/60 text-amber-800 rounded text-[10px] font-bold">Receipt-Freeness</span>
              </p>
            </div>
          </div>
          <div className="p-6 space-y-3">
            <div className="bg-slate-50 rounded-lg p-4 space-y-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Receipt-Free 원리</p>
              <div className="space-y-1.5 text-[11px] text-slate-600">
                <p>1. 서버는 nullifier 존재 여부만 확인 → <span className="font-semibold">포함/미포함</span>만 반환</p>
                <p>2. 후보자 정보, Merkle proof, 암호문 등 <span className="font-semibold text-red-600">일체 미반환</span></p>
                <p>3. 따라서 유권자는 <span className="font-semibold">자신이 투표했다는 사실</span>만 확인 가능</p>
                <p>4. 강압자에게 "누구를 찍었는지" 증명하는 receipt 생성이 <span className="font-semibold text-red-600">원천 불가</span></p>
              </div>
            </div>
            <Alert variant="info">
              후보자 정보, Merkle proof 등 증명 데이터는 반환되지 않습니다 — receipt 생성 불가 (Receipt-Free 속성)
            </Alert>
          </div>
        </div>
      )}
    </div>
  );
}

function VerifyItem({ label, ok }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {ok ? (
        <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      )}
      <span className="text-slate-700">{label}: <span className={`font-bold ${ok ? 'text-emerald-600' : 'text-red-600'}`}>{ok ? 'YES' : 'NO'}</span></span>
    </div>
  );
}
