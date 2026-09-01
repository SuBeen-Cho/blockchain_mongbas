/**
 * AdminPage.jsx — 관리자 대시보드 (자동 진행 방식)
 *
 * 각 단계 완료 시 다음 섹션이 자동으로 열립니다.
 * 선거 생성 → 활성화 → (투표 진행) → 종료 → 개표 → Merkle → 키 분산 → Bulletin Board → 보안 속성
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import Alert from '../components/Alert.jsx';

const API = '/api';
let activeAdminToken = '';

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(activeAdminToken ? { Authorization: `Bearer ${activeAdminToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

/* ── 토글 가능한 섹션 ────────────────────────────── */
function Section({ title, number, open, done, onToggle, children }) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!innerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (innerRef.current) setHeight(innerRef.current.scrollHeight);
    });
    ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all duration-300 ${
      done ? 'border-emerald-200' : open ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200'
    }`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-6 py-4 flex items-center gap-3 hover:bg-slate-50/50 transition-colors duration-200 text-left"
      >
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors duration-300 ${
          done ? 'bg-emerald-500 text-white' : open ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'
        }`}>
          {done ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : number}
        </span>
        <span className={`text-sm font-semibold flex-1 transition-colors ${done ? 'text-emerald-700' : 'text-slate-800'}`}>
          {title}
          {done && <span className="ml-2 text-xs font-normal text-emerald-500">완료</span>}
        </span>
        <svg className={`w-4 h-4 text-slate-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        ref={outerRef}
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: open ? Math.max(height, 2000) + 'px' : '0px',
          opacity: open ? 1 : 0,
        }}
      >
        <div ref={innerRef} className="px-6 pb-5 pt-2 border-t border-slate-100 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}

function Btn({ onClick, loading, variant = 'primary', className = '', children }) {
  const styles = {
    primary:   'bg-blue-600 text-white hover:bg-blue-700 shadow-sm shadow-blue-600/10',
    success:   'bg-emerald-600 text-white hover:bg-emerald-700',
    danger:    'bg-red-600 text-white hover:bg-red-700',
    secondary: 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200',
  };
  return (
    <button
      onClick={onClick}
      disabled={loading}
      aria-busy={loading}
      className={`h-10 px-4 rounded-lg text-sm font-semibold transition-all duration-200 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-1
        ${loading ? 'opacity-50 cursor-not-allowed' : styles[variant]} ${className}`}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          처리 중...
        </span>
      ) : children}
    </button>
  );
}

function SuccessBanner({ children }) {
  return (
    <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-sm text-emerald-700">
      <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      {children}
    </div>
  );
}

const INPUT = "h-10 px-3 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-colors duration-200";

export default function AdminPage() {
  const [adminToken, setAdminToken] = useState('');
  const [busy, setBusy] = useState({});
  const [res,  setRes]  = useState({});
  const [err,  setErr]  = useState({});

  // 섹션 열림/닫힘 상태 (0-based)
  const [openSection, setOpenSection] = useState(0);
  // 완료된 섹션들
  const [doneSections, setDoneSections] = useState(new Set());

  // 섹션 자동 스크롤
  const sectionRefs = useRef([]);

  const scrollToSection = useCallback((idx) => {
    setTimeout(() => {
      sectionRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 600);
  }, []);

  // 작업 실행 + 성공 시 다음 섹션 자동 열기
  const run = (key, fn, sectionIdx, nextSection) => {
    return async () => {
      setBusy(b => ({ ...b, [key]: true }));
      setRes(r => ({ ...r, [key]: null }));
      setErr(e => ({ ...e, [key]: '' }));
      try {
        const data = await fn();
        setRes(r => ({ ...r, [key]: data }));
        // 성공 시 현재 섹션 완료 + 다음 섹션 열기
        if (nextSection !== undefined) {
          setDoneSections(prev => new Set([...prev, sectionIdx]));
          setOpenSection(nextSection);
          scrollToSection(nextSection);
        }
      } catch (e) {
        setErr(er => ({ ...er, [key]: e.message }));
      } finally {
        setBusy(b => ({ ...b, [key]: false }));
      }
    };
  };

  // 섹션 클릭으로 직접 토글 (수동 접기/펼치기)
  const toggleSection = (idx) => {
    setOpenSection(prev => prev === idx ? -1 : idx);
  };

  const [newID,         setNewID]         = useState('');
  const [newTitle,      setNewTitle]      = useState('');
  const [newDesc,       setNewDesc]       = useState('');
  const [newCandidates, setNewCandidates] = useState('');
  const [newEncMode,    setNewEncMode]    = useState('elgamal-vector-v3');
  const [eid,           setEid]           = useState('');
  const [shareIdx,      setShareIdx]      = useState('1');

  const endTime = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;

  // 선거 생성 시 자동으로 eid 동기화 + 상태 조회
  useEffect(() => {
    if (res.create?.electionID) {
      const newEid = res.create.electionID;
      if (!eid || eid === newEid) {
        setEid(newEid);
        // 자동 상태 조회
        apiGet(`${API}/elections/${newEid}`)
          .then(data => setRes(r => ({ ...r, info: data })))
          .catch(() => {});
      }
    }
  }, [res.create]);

  // 선거 상태 파악
  const electionInfo = res.info;
  const statusSteps = ['CREATED', 'ACTIVE', 'CLOSED'];
  const currentStatus = electionInfo?.status || '';
  const statusIndex = statusSteps.indexOf(currentStatus);

  return (
    <div className="space-y-4">
      {/* 페이지 헤더 */}
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-slate-900">관리자 대시보드</h1>
        <p className="text-sm text-slate-500 mt-1">각 단계를 완료하면 다음 단계가 자동으로 열립니다.</p>
      </div>

      <div className="bg-amber-50 rounded-xl border border-amber-200 p-4 space-y-2">
        <label className="block text-sm font-semibold text-amber-900">관리자 API 토큰</label>
        <input
          type="password"
          autoComplete="off"
          className={`w-full font-mono ${INPUT}`}
          value={adminToken}
          onChange={(e) => { activeAdminToken = e.target.value; setAdminToken(e.target.value); }}
          placeholder="Linux runtime의 ADMIN_API_TOKEN을 입력하세요"
        />
        <p className="text-xs text-amber-800">토큰은 이 페이지의 메모리에만 유지되며 localStorage·URL·Git에 저장되지 않습니다.</p>
      </div>

      {/* 선거 ID 입력 + 상태 조회 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <label className="block text-sm font-medium text-slate-700">선거 ID (모든 작업에 공통)</label>
        <div className="flex gap-3">
          <input
            className={`flex-1 font-mono ${INPUT}`}
            placeholder="예: ELECTION_2026_PRESIDENT"
            value={eid}
            onChange={e => setEid(e.target.value)}
          />
          <Btn loading={busy.info} onClick={run('info', () => apiGet(`${API}/elections/${eid}`))}>
            상태 조회
          </Btn>
        </div>

        {/* 진행 상태 스텝퍼 */}
        {electionInfo && (
          <div className="flex items-center gap-0 pt-2">
            {statusSteps.map((s, i) => {
              const done = i <= statusIndex;
              const isCurrent = i === statusIndex;
              return (
                <div key={s} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center">
                    <div className={`
                      w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300
                      ${done ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}
                      ${isCurrent ? 'ring-4 ring-blue-100' : ''}
                    `}>
                      {done && i < statusIndex ? (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                      ) : i + 1}
                    </div>
                    <span className={`mt-1 text-[11px] font-medium ${isCurrent ? 'text-blue-600' : done ? 'text-slate-600' : 'text-slate-400'}`}>{s}</span>
                  </div>
                  {i < statusSteps.length - 1 && (
                    <div className={`flex-1 h-0.5 mx-2 rounded transition-colors duration-300 ${i < statusIndex ? 'bg-blue-600' : 'bg-slate-200'}`} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* KPI 카드 */}
        {electionInfo && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div className="bg-slate-50 rounded-lg p-4 text-center">
              <p className="text-2xl font-bold text-slate-900">{electionInfo.totalVotes || 0}</p>
              <p className="text-xs text-slate-500 mt-1">총 투표수</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-4 text-center">
              <p className="text-sm font-bold text-slate-900 mt-1.5">
                {electionInfo.encryptionMode === 'elgamal-vector-v3' ? (
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">Vector ElGamal v3</span>
                ) : electionInfo.encryptionMode === 'elgamal' ? (
                  <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">Legacy scalar ElGamal</span>
                ) : (
                  <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">AES-256-GCM</span>
                )}
              </p>
              <p className="text-xs text-slate-500 mt-2">암호화 모드</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-4 text-center">
              <p className="text-sm font-bold text-amber-600 mt-1.5">독립 검증 진행 중</p>
              <p className="text-xs text-slate-500 mt-2">7대 보안 속성</p>
            </div>
          </div>
        )}

        {/* 개표 결과 요약 — 종료 후 항상 표시 */}
        {res.tally?.results && (
          <div className="bg-gradient-to-r from-blue-50 to-emerald-50 border border-blue-200 rounded-xl p-4 mt-3">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
              <span className="text-xs font-bold text-blue-800">개표 결과 (총 {res.tally.totalVotes}표)</span>
              {res.tally.panicFiltered > 0 && <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-600 rounded font-semibold">Panic {res.tally.panicFiltered}건 제외</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              {Object.entries(res.tally.results).sort(([,a],[,b]) => b - a).map(([c, n]) => (
                <span key={c} className="text-sm font-semibold text-slate-800">{c}: <span className="text-blue-700">{n}표</span></span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ═══════ 1. 선거 생성 ═══════ */}
      <div ref={el => sectionRefs.current[0] = el}>
        <Section title="선거 생성" number="1" open={openSection === 0} done={doneSections.has(0)} onToggle={() => toggleSection(0)}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">선거 ID</label>
              <input className={`w-full ${INPUT}`} placeholder="예: test2026" value={newID} onChange={e => setNewID(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">제목</label>
              <input className={`w-full ${INPUT}`} placeholder="예: 전자투표 2026" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">설명</label>
            <input className={`w-full ${INPUT}`} placeholder="선거에 대한 설명" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">후보자</label>
            <input className={`w-full ${INPUT}`} placeholder="쉼표로 구분 (예: 김길동, 가길동, 길동김)" value={newCandidates} onChange={e => setNewCandidates(e.target.value)} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-500">암호화:</span>
              {['elgamal-vector-v3', 'aes'].map(m => (
                <button key={m} onClick={() => setNewEncMode(m)}
                  className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all duration-200 ${
                    newEncMode === m ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:border-blue-300'
                  }`}
                >{m === 'aes' ? 'AES-256-GCM (legacy)' : 'Vector ElGamal v3'}</button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 px-1">
              {newEncMode === 'elgamal-vector-v3'
                ? 'Vector ElGamal v3: 후보별 one-hot 암호문, ballot ZKP, 2-of-3 증명된 partial decryption을 사용합니다. 정식 검증 프로파일입니다.'
                : 'AES는 레거시 비교·데모용이며 threshold ElGamal 보안성 평가 대상이 아닙니다.'}
            </p>
          </div>
          {err.create && <Alert variant="error">{err.create}</Alert>}
          {res.create && (
            <div className="space-y-2">
              <SuccessBanner>선거가 생성되었습니다 — ID: {res.create.electionID}</SuccessBanner>
              <p className="text-[11px] text-blue-600 px-1">2-of-3 endorsement: 선관위 + 참관정당 + 시민단체 중 2개 이상 기관이 서명하여 블록체인에 기록됨</p>
            </div>
          )}
          <Btn loading={busy.create} onClick={run('create', () => apiPost(`${API}/elections`, {
            electionID: newID || eid, title: newTitle, description: newDesc,
            candidates: newCandidates.split(',').map(s => s.trim()).filter(Boolean),
            endTime, encryptionMode: newEncMode,
          }), 0, 1)}>
            선거 생성
          </Btn>
        </Section>
      </div>

      {/* ═══════ 2. 활성화 ═══════ */}
      <div ref={el => sectionRefs.current[1] = el}>
        <Section title="선거 활성화 (CREATED → ACTIVE)" number="2" open={openSection === 1} done={doneSections.has(1)} onToggle={() => toggleSection(1)}>
          <p className="text-xs text-slate-500">투표를 시작하려면 선거를 활성화하세요.</p>
          {err.activate && <Alert variant="error">{err.activate}</Alert>}
          {res.activate && <SuccessBanner>선거가 활성화되었습니다 — 이제 투표를 받을 수 있습니다.</SuccessBanner>}
          <Btn variant="success" loading={busy.activate} onClick={run('activate', () => apiPost(`${API}/elections/${eid}/activate`), 1, 2)}>
            활성화
          </Btn>
        </Section>
      </div>

      {/* ═══════ 3. 종료 ═══════ */}
      <div ref={el => sectionRefs.current[2] = el}>
        <Section title="선거 종료 + 자동 집계" number="3" open={openSection === 2} done={doneSections.has(2)} onToggle={() => toggleSection(2)}>
          <p className="text-xs text-slate-500">투표를 마감하고 집계를 시작합니다. 이 작업은 되돌릴 수 없습니다.</p>
          {currentStatus === 'CLOSED' && (
            <Alert variant="info">이미 종료된 선거입니다.</Alert>
          )}
          {err.close && <Alert variant="error">{err.close}</Alert>}
          {res.close && <SuccessBanner>선거가 종료되고 집계가 완료되었습니다.</SuccessBanner>}
          <Btn variant="danger" loading={busy.close} onClick={run('close', async () => {
            const closeData = await apiPost(`${API}/elections/${eid}/close`);
            // 종료 후 자동으로 집계 결과 + 상태 조회
            const [tallyData, infoData] = await Promise.all([
              apiGet(`${API}/elections/${eid}/tally`).catch(() => null),
              apiGet(`${API}/elections/${eid}`).catch(() => null),
            ]);
            if (tallyData) setRes(r => ({ ...r, tally: tallyData }));
            if (infoData) setRes(r => ({ ...r, info: infoData }));
            return closeData;
          }, 2, 3)}>
            선거 종료
          </Btn>
        </Section>
      </div>

      {/* ═══════ 4. 개표 결과 ═══════ */}
      <div ref={el => sectionRefs.current[3] = el}>
        <Section title="개표 결과 조회" number="4" open={openSection === 3} done={doneSections.has(3)} onToggle={() => toggleSection(3)}>
          {err.tally && <Alert variant="error">{err.tally}</Alert>}
          {res.tally && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline gap-4">
                <p className="text-sm text-slate-600">
                  총 투표수: <span className="font-bold text-slate-900 text-lg">{res.tally.totalVotes}</span>표
                </p>
                {res.tally.panicFiltered > 0 && (
                  <span className="px-2.5 py-1 bg-red-50 border border-red-200 text-red-600 rounded-lg text-xs font-semibold">
                    Panic 투표 {res.tally.panicFiltered}건 제외됨
                  </span>
                )}
                {res.tally.evictedCount > 0 && (
                  <span className="px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-600 rounded-lg text-xs font-semibold">
                    재투표(덮어쓰기) {res.tally.evictedCount}건
                  </span>
                )}
              </div>
              {res.tally.results && Object.entries(res.tally.results)
                .sort(([,a],[,b]) => b - a)
                .map(([candidate, count], idx) => {
                  const pct = res.tally.totalVotes > 0 ? Math.round(count / res.tally.totalVotes * 100) : 0;
                  const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500', 'bg-pink-500'];
                  return (
                    <div key={candidate}>
                      <div className="flex justify-between mb-1.5 text-sm">
                        <span className="font-semibold text-slate-800">{candidate}</span>
                        <span className="font-mono font-semibold text-slate-600">{count}표 ({pct}%)</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-3.5 overflow-hidden">
                        <div className={`h-3.5 rounded-full transition-all duration-700 ease-out ${colors[idx % colors.length]}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-1 transition-colors">JSON 원본 보기</summary>
                <pre className="mt-2 bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-auto text-xs font-mono">{JSON.stringify(res.tally, null, 2)}</pre>
              </details>
            </div>
          )}
          <Btn variant="secondary" loading={busy.tally} onClick={run('tally', () => apiGet(`${API}/elections/${eid}/tally`), 3, 4)}>
            결과 조회
          </Btn>
        </Section>
      </div>

      {/* ═══════ 5. Merkle Tree ═══════ */}
      <div ref={el => sectionRefs.current[4] = el}>
        <Section title="Merkle Tree 구축 (E2E 검증)" number="5" open={openSection === 4} done={doneSections.has(4)} onToggle={() => toggleSection(4)}>
          <p className="text-xs text-slate-500">투표 데이터를 Merkle tree로 구축하여 개별 투표의 포함 증명을 활성화합니다.</p>
          {(err.buildMerkle || err.getMerkle) && <Alert variant="error">{err.buildMerkle || err.getMerkle}</Alert>}
          {(res.buildMerkle || res.getMerkle) && <SuccessBanner>Merkle tree가 구축되었습니다.</SuccessBanner>}
          <div className="flex gap-2">
            <Btn loading={busy.buildMerkle} onClick={run('buildMerkle', () => apiPost(`${API}/elections/${eid}/merkle`), 4, 5)}>Tree 구축</Btn>
            <Btn variant="secondary" loading={busy.getMerkle} onClick={run('getMerkle', () => apiGet(`${API}/elections/${eid}/merkle`))}>Root 조회</Btn>
          </div>
        </Section>
      </div>

      {/* ═══════ 6. Shamir SSS ═══════ */}
      <div ref={el => sectionRefs.current[5] = el}>
        <Section title="2-of-3 threshold partial decryption" number="6" open={openSection === 5} done={doneSections.has(5)} onToggle={() => toggleSection(5)}>
          <p className="text-xs text-slate-500">완전한 private key를 복원하지 않고, 기관별 partial decryption과 Chaum–Pedersen proof를 제출합니다.</p>

          {/* 기관별 partial decryption 제출 */}
          <div className="bg-slate-50 rounded-lg p-4 space-y-3">
            <p className="text-xs font-semibold text-slate-600">기관 partial decryption 제출</p>
            <div className="flex gap-2 items-center">
              <select className={`${INPUT} w-auto`} value={shareIdx} onChange={e => setShareIdx(e.target.value)}>
                <option value="1">기관 1 (선관위)</option>
                <option value="2">기관 2 (참관정당)</option>
                <option value="3">기관 3 (시민단체)</option>
              </select>
              <Btn variant="success" loading={busy.submitShare} onClick={run('submitShare', () => apiPost(`${API}/elections/${eid}/partial-decryptions`, { shareIndex: shareIdx }))}>증명 생성 + 제출</Btn>
            </div>
            {err.submitShare && <Alert variant="error">{err.submitShare}</Alert>}
            {res.submitShare && (
              <div className="space-y-2">
                <SuccessBanner>기관 {shareIdx}의 partial decryption과 proof가 제출되었습니다.</SuccessBanner>
                <div className="flex items-center gap-3 text-xs text-slate-600">
                  <span>제출: <span className="font-bold">{res.submitShare.submittedCount || '?'}</span> / {res.submitShare.totalShares || 3}</span>
                  <span>Threshold: <span className="font-bold">{res.submitShare.threshold || 2}</span></span>
                  {res.submitShare.isDecrypted && (
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full font-bold">threshold 복호화 완료</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 복원 현황 */}
          {err.decStatus && <Alert variant="error">{err.decStatus}</Alert>}
          {res.decStatus && (
            <div className="bg-slate-50 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-slate-700">복원 상태:</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${res.decStatus.isDecrypted ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                  {res.decStatus.isDecrypted ? 'threshold 복호화 완료' : '대기 중'}
                </span>
              </div>
              <div className="flex gap-4 text-sm text-slate-600">
                <span>제출: <span className="font-bold">{res.decStatus.submittedCount || 0}</span> / {res.decStatus.totalShares || 3}</span>
                <span>Threshold: <span className="font-bold">{res.decStatus.threshold || 2}</span></span>
              </div>
            </div>
          )}
          <Btn variant="secondary" loading={busy.decStatus} onClick={run('decStatus', () => apiGet(`${API}/elections/${eid}/decryption`), 5, 6)}>
            복원 현황 조회 → 다음
          </Btn>
        </Section>
      </div>

      {/* ═══════ 7. Bulletin Board ═══════ */}
      <div ref={el => sectionRefs.current[6] = el}>
        <Section title="Bulletin Board 공개 (Universal Verifiability)" number="7" open={openSection === 6} done={doneSections.has(6)} onToggle={() => toggleSection(6)}>
          <p className="text-xs text-slate-500">
            암호화 키와 투표를 공개하여 누구나 독립 검증 가능하게 합니다.
          </p>
          {err.publishAudit && <Alert variant="error">{err.publishAudit}</Alert>}
          {res.publishAudit && (
            <div className="space-y-2">
              <SuccessBanner>Audit 데이터가 공개되었습니다 — 검증 탭에서 누구나 확인 가능합니다.</SuccessBanner>
              <div className="flex flex-wrap gap-2 text-xs">
                {res.publishAudit.totalBallots != null && (
                  <span className="px-2 py-1 bg-blue-50 border border-blue-200 text-blue-700 rounded-lg font-medium">공개 투표: {res.publishAudit.totalBallots}건</span>
                )}
                <span className="px-2 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg font-medium">암호화 키 공개됨</span>
                <span className="px-2 py-1 bg-purple-50 border border-purple-200 text-purple-700 rounded-lg font-medium">셔플 증명 포함</span>
              </div>
            </div>
          )}
          <Btn loading={busy.publishAudit} onClick={run('publishAudit', () => apiPost(`${API}/elections/${eid}/publish-audit`, { electionID: eid }), 6, 7)}>
            Audit Data 공개
          </Btn>
        </Section>
      </div>

      {/* ═══════ 8. 보안 속성 ═══════ */}
      <div ref={el => sectionRefs.current[7] = el}>
        <Section title="Security Properties (보안 속성 진단)" number="8" open={openSection === 7} done={doneSections.has(7)} onToggle={() => toggleSection(7)}>
          <Alert variant="warning">이 화면은 체인코드가 선언한 기능 메타데이터만 보여줍니다. 7대 보안 속성의 독립 검증이나 7/7 달성 증거로 사용할 수 없습니다.</Alert>
          {err.secProps && <Alert variant="error">{err.secProps}</Alert>}
          {res.secProps && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(res.secProps.properties || {}).filter(([k]) =>
                !['electionID', 'verifiedAt', 'docType'].includes(k)
              ).map(([key, prop]) => {
                if (!prop || typeof prop !== 'object') return null;
                return (
                  <div key={key} className={`rounded-lg border p-3 ${
                    prop.status === 'ACHIEVED' ? 'bg-blue-50 border-blue-200' :
                    prop.status === 'PARTIAL'  ? 'bg-amber-50 border-amber-200' :
                    'bg-slate-50 border-slate-200'
                  }`}>
                    <div className="flex justify-between items-start mb-1.5">
                      <span className="text-sm font-semibold text-slate-800">{key}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        prop.status === 'ACHIEVED' ? 'bg-blue-200 text-blue-800' :
                        prop.status === 'PARTIAL'  ? 'bg-amber-200 text-amber-800' :
                        'bg-slate-200 text-slate-600'
                      }`}>선언: {prop.status}</span>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">{prop.mechanism}</p>
                    {prop.assumption && <p className="text-[11px] text-slate-400 mt-1">assumption: {prop.assumption}</p>}
                  </div>
                );
              })}
            </div>
          )}
          <Btn variant="secondary" loading={busy.secProps} onClick={run('secProps', () => apiGet(`${API}/elections/security-properties`), 7)}>
            보안 속성 조회
          </Btn>
        </Section>
      </div>
    </div>
  );
}
