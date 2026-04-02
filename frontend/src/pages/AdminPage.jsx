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

  const run = (key, fn) => async () => {
    setBusy(b => ({ ...b, [key]: true }));
    setRes(r => ({ ...r, [key]: null }));
    setErr(e => ({ ...e, [key]: '' }));
    try   { setRes(r => ({ ...r, [key]: await fn() })); }
    catch (e) { setErr(er => ({ ...er, [key]: e.message })); }
    finally { setBusy(b => ({ ...b, [key]: false })); }
  };

  // ── 선거 생성 ─────────────────────────────────────
  const [newID,          setNewID]          = useState('');
  const [newTitle,       setNewTitle]       = useState('');
  const [newDesc,        setNewDesc]        = useState('');
  const [newCandidates,  setNewCandidates]  = useState('');

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
        <Btn
          loading={busy.create}
          onClick={run('create', () => apiPost(`${API}/elections`, {
            electionID:  newID || eid,
            title:       newTitle,
            description: newDesc,
            candidates:  newCandidates.split(',').map(s => s.trim()).filter(Boolean),
            endTime,
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
        <Msg data={res.tally} error={err.tally} />
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
        <Msg data={res.decStatus} error={err.decStatus} />
      </Section>
    </div>
  );
}
