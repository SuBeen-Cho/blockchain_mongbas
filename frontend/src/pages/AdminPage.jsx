/**
 * AdminPage.jsx — 관리자 UI
 *
 * 선거 생성 → 활성화 → 종료 → Merkle Tree 구축 → Shamir 키 분산 → 복원 현황
 */

import { useState } from 'react';

const API = '/api';

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

function Section({ title, children }) {
  return (
    <section className="bg-white rounded-xl shadow p-5 space-y-3">
      <h3 className="font-bold text-gray-700 border-b pb-2">{title}</h3>
      {children}
    </section>
  );
}

function Btn({ onClick, loading, color = 'blue', children }) {
  const colors = {
    blue:  'bg-blue-600 hover:bg-blue-700',
    green: 'bg-green-600 hover:bg-green-700',
    red:   'bg-red-600 hover:bg-red-700',
    gray:  'bg-gray-500 hover:bg-gray-600',
  };
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-4 py-2 rounded text-white text-sm font-medium ${loading ? 'bg-gray-400' : colors[color]}`}
    >
      {loading ? '처리 중...' : children}
    </button>
  );
}

function Msg({ data, error }) {
  if (error) return <p className="text-red-600 text-sm">{error}</p>;
  if (data)  return <pre className="bg-gray-50 border rounded p-2 text-xs overflow-auto">{JSON.stringify(data, null, 2)}</pre>;
  return null;
}

export default function AdminPage() {
  const [busy, setBusy] = useState({});
  const [res,  setRes]  = useState({});
  const [err,  setErr]  = useState({});

  const run = (key, fn) => {
    return async () => {
      setBusy(b => ({ ...b, [key]: true }));
      setRes(r => ({ ...r, [key]: null }));
      setErr(e => ({ ...e, [key]: '' }));
      try {
        const data = await fn();
        setRes(r => ({ ...r, [key]: data }));
      } catch (e) {
        setErr(er => ({ ...er, [key]: e.message }));
      } finally {
        setBusy(b => ({ ...b, [key]: false }));
      }
    };
  };

  // ── 선거 생성 ─────────────────────────────────────
  const [newID,          setNewID]          = useState('');
  const [newTitle,       setNewTitle]       = useState('');
  const [newDesc,        setNewDesc]        = useState('');
  const [newCandidates,  setNewCandidates]  = useState('');
  const [newEncMode,     setNewEncMode]     = useState('aes'); // 'aes' | 'elgamal'

  // ── 선거 ID 입력 (공통) ───────────────────────────
  const [eid,      setEid]      = useState('');
  const [shareIdx, setShareIdx] = useState('1');
  const [shareHex, setShareHex] = useState('');

  const endTime = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7일 후

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
        ⚠️ 관리자 전용 화면입니다. 선거 진행 순서: 생성 → 활성화 → 종료 → Merkle 구축 → Shamir 분산
      </p>

      {/* 공통 선거 ID */}
      <div className="flex gap-2 items-center">
        <input
          className="border rounded px-3 py-2 flex-1 text-sm"
          placeholder="선거 ID (모든 작업에 공통 사용)"
          value={eid}
          onChange={e => setEid(e.target.value)}
        />
      </div>

      {/* ─── 1. 선거 생성 ─────────────────────────── */}
      <Section title="1. 선거 생성">
        <input className="border rounded px-3 py-2 w-full text-sm" placeholder="선거 ID" value={newID}    onChange={e => setNewID(e.target.value)} />
        <input className="border rounded px-3 py-2 w-full text-sm" placeholder="제목"    value={newTitle}  onChange={e => setNewTitle(e.target.value)} />
        <input className="border rounded px-3 py-2 w-full text-sm" placeholder="설명"    value={newDesc}   onChange={e => setNewDesc(e.target.value)} />
        <input className="border rounded px-3 py-2 w-full text-sm" placeholder="후보자 (쉼표 구분, 예: A,B,C)" value={newCandidates} onChange={e => setNewCandidates(e.target.value)} />
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">암호화 모드:</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="aes" checked={newEncMode==='aes'} onChange={() => setNewEncMode('aes')} />
            AES-256-GCM
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" value="elgamal" checked={newEncMode==='elgamal'} onChange={() => setNewEncMode('elgamal')} />
            ElGamal (PAPER-11)
          </label>
        </div>
        {newEncMode === 'elgamal' && (
          <p className="text-xs text-purple-600">
            ElGamal 공개키 암호화 — Chaum-Pedersen ZKP로 키 공개 없이 복호화 검증 가능
          </p>
        )}
        <Btn
          loading={busy.create}
          onClick={run('create', () => apiPost(`${API}/elections`, {
            electionID:  newID || eid,
            title:       newTitle,
            description: newDesc,
            candidates:  newCandidates.split(',').map(s => s.trim()).filter(Boolean),
            endTime,
            encryptionMode: newEncMode,
          }))}
        >선거 생성</Btn>
        <Msg data={res.create} error={err.create} />
      </Section>

      {/* ─── 2. 활성화 ────────────────────────────── */}
      <Section title="2. 선거 활성화 (CREATED → ACTIVE)">
        <Btn color="green" loading={busy.activate} onClick={run('activate', () => apiPost(`${API}/elections/${eid}/activate`))}>활성화</Btn>
        <Msg data={res.activate} error={err.activate} />
      </Section>

      {/* ─── 3. 선거 조회 ─────────────────────────── */}
      <Section title="3. 선거 상태 조회">
        <Btn color="gray" loading={busy.info} onClick={run('info', () => apiGet(`${API}/elections/${eid}`))}>조회</Btn>
        <Msg data={res.info} error={err.info} />
      </Section>

      {/* ─── 4. 종료 ──────────────────────────────── */}
      <Section title="4. 선거 종료 + 자동 집계">
        <Btn color="red" loading={busy.close} onClick={run('close', () => apiPost(`${API}/elections/${eid}/close`))}>선거 종료</Btn>
        <Msg data={res.close} error={err.close} />
      </Section>

      {/* ─── 5. 개표 결과 ─────────────────────────── */}
      <Section title="5. 개표 결과 조회">
        <Btn color="gray" loading={busy.tally} onClick={run('tally', () => apiGet(`${API}/elections/${eid}/tally`))}>결과 조회</Btn>
        {err.tally && <p className="text-red-600 text-sm">{err.tally}</p>}
        {res.tally && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">총 투표수: <span className="font-bold">{res.tally.totalVotes}</span></p>
            {res.tally.results && Object.entries(res.tally.results)
              .sort(([,a],[,b]) => b - a)
              .map(([candidate, count]) => {
                const pct = res.tally.totalVotes > 0 ? Math.round(count / res.tally.totalVotes * 100) : 0;
                return (
                  <div key={candidate} className="text-sm">
                    <div className="flex justify-between mb-1">
                      <span className="font-medium">{candidate}</span>
                      <span className="text-gray-500">{count}표 ({pct}%)</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-4">
                      <div className="bg-blue-600 h-4 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            <details className="text-xs mt-2">
              <summary className="cursor-pointer text-gray-500">JSON 원본 보기</summary>
              <pre className="mt-1 bg-gray-50 border rounded p-2 overflow-auto">{JSON.stringify(res.tally, null, 2)}</pre>
            </details>
          </div>
        )}
      </Section>

      {/* ─── 6. Merkle Tree ───────────────────────── */}
      <Section title="6. Merkle Tree 구축 (E2E 검증 활성화)">
        <div className="flex gap-2 flex-wrap">
          <Btn loading={busy.buildMerkle} onClick={run('buildMerkle', () => apiPost(`${API}/elections/${eid}/merkle`))}>Tree 구축</Btn>
          <Btn color="gray" loading={busy.getMerkle} onClick={run('getMerkle', () => apiGet(`${API}/elections/${eid}/merkle`))}>Root 조회</Btn>
        </div>
        <Msg data={res.buildMerkle || res.getMerkle} error={err.buildMerkle || err.getMerkle} />
      </Section>

      {/* ─── 7. Shamir SSS ────────────────────────── */}
      <Section title="7. Shamir SSS — 분산 개표 키 관리">
        <p className="text-xs text-gray-500">masterKey를 3개 기관에 분산합니다. 2개 이상 제출 시 자동 복원.</p>
        <Btn loading={busy.initKey} onClick={run('initKey', () => apiPost(`${API}/elections/${eid}/keysharing`))}>키 분산 초기화</Btn>
        <Msg data={res.initKey} error={err.initKey} />

        <div className="flex gap-2 mt-2">
          <select
            className="border rounded px-2 py-2 text-sm"
            value={shareIdx}
            onChange={e => setShareIdx(e.target.value)}
          >
            <option value="1">Share 1 (선관위)</option>
            <option value="2">Share 2 (참관정당)</option>
            <option value="3">Share 3 (시민단체)</option>
          </select>
          <Btn color="gray" loading={busy.getShare} onClick={run('getShare', async () => {
            const r = await apiGet(`${API}/elections/${eid}/shares/${shareIdx}`);
            setShareHex(r.shareHex || '');
            return r;
          })}>Share 조회</Btn>
        </div>
        {shareHex && <input className="border rounded px-3 py-2 w-full text-xs font-mono" readOnly value={shareHex} />}

        <div className="flex gap-2 mt-2">
          <select className="border rounded px-2 py-2 text-sm" value={shareIdx} onChange={e => setShareIdx(e.target.value)}>
            <option value="1">Share 1</option>
            <option value="2">Share 2</option>
            <option value="3">Share 3</option>
          </select>
          <input className="border rounded px-3 py-2 flex-1 text-xs font-mono" placeholder="shareHex" value={shareHex} onChange={e => setShareHex(e.target.value)} />
          <Btn color="green" loading={busy.submitShare} onClick={run('submitShare', () => apiPost(`${API}/elections/${eid}/shares`, { shareIndex: shareIdx, shareHex }))}>제출</Btn>
        </div>
        <Msg data={res.submitShare} error={err.submitShare} />

        <Btn color="gray" loading={busy.decStatus} onClick={run('decStatus', () => apiGet(`${API}/elections/${eid}/decryption`))}>복원 현황 조회</Btn>
        {err.decStatus && <p className="text-red-600 text-sm">{err.decStatus}</p>}
        {res.decStatus && (
          <div className="text-sm space-y-1 bg-gray-50 border rounded p-3">
            <p>
              복원 상태:{' '}
              <span className={`font-bold ${res.decStatus.restored ? 'text-green-600' : 'text-yellow-600'}`}>
                {res.decStatus.restored ? '복원 완료' : '대기 중'}
              </span>
            </p>
            <p>제출된 Share: {res.decStatus.submittedCount || 0} / {res.decStatus.totalShares || 3}</p>
            <p>필요 Threshold: {res.decStatus.threshold || 2}</p>
          </div>
        )}
      </Section>

      {/* ─── 8. Bulletin Board 공개 (PAPER-6) ─────── */}
      <Section title="8. Bulletin Board 공개 (Universal Verifiability)">
        <p className="text-xs text-gray-500">
          선거 종료 + 키 복원 완료 후, 암호화 키와 모든 투표를 공개하여 누구나 독립 검증 가능하게 합니다.
          공개 후에는 검증 탭의 "Bulletin Board" 모드에서 누구나 집계를 검증할 수 있습니다.
        </p>
        <Btn loading={busy.publishAudit} onClick={run('publishAudit', () => apiPost(`${API}/elections/${eid}/publish-audit`, { electionID: eid }))}>
          Audit Data 공개
        </Btn>
        <Msg data={res.publishAudit} error={err.publishAudit} />
      </Section>

      {/* ─── 9. 보안 속성 대시보드 (PAPER-5) ─────── */}
      <Section title="9. Security Properties (보안 속성 진단)">
        <p className="text-xs text-gray-500">
          체인코드에서 자가 진단한 보안 속성 현황입니다. 논문 Section 5 (Security Analysis)에 대응합니다.
        </p>
        <Btn color="gray" loading={busy.secProps} onClick={run('secProps', () => apiGet(`${API}/elections/security-properties`))}>
          보안 속성 조회
        </Btn>
        {err.secProps && <p className="text-red-600 text-sm">{err.secProps}</p>}
        {res.secProps && (
          <div className="space-y-2">
            {Object.entries(res.secProps).filter(([k]) =>
              !['electionID', 'verifiedAt', 'docType'].includes(k)
            ).map(([key, prop]) => {
              if (!prop || typeof prop !== 'object') return null;
              const isAchieved = prop.status === 'ACHIEVED' || prop.status === 'PARTIAL';
              return (
                <div key={key} className={`border rounded p-3 text-sm ${
                  prop.status === 'ACHIEVED' ? 'bg-green-50 border-green-200' :
                  prop.status === 'PARTIAL'  ? 'bg-yellow-50 border-yellow-200' :
                  'bg-gray-50 border-gray-200'
                }`}>
                  <div className="flex justify-between items-center">
                    <span className="font-medium">{key}</span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                      prop.status === 'ACHIEVED' ? 'bg-green-200 text-green-800' :
                      prop.status === 'PARTIAL'  ? 'bg-yellow-200 text-yellow-800' :
                      'bg-gray-200 text-gray-600'
                    }`}>{prop.status}</span>
                  </div>
                  <p className="text-xs text-gray-600 mt-1">{prop.mechanism}</p>
                  {prop.assumption && (
                    <p className="text-xs text-gray-400 mt-0.5">assumption: {prop.assumption}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
