import { useState } from 'react';
import { computeMerkleRootFromProof } from '../utils/crypto.js';

/**
 * TrackPage — "내 표 추적" 검증 화면 (Phase 5)
 * 진입: /?app=track&e=<electionID>
 *
 * 영수번호(추적번호) 하나로: 게시판에서 내 줄 찾기 → Merkle 봉인 일치 →
 *   집계 기여 확인. 번호를 변조하면 추적 실패(빨간 X).
 */
const API = '/api';

async function J(path, opts = {}) {
  const r = await fetch(API + path, opts);
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) throw new Error(j.error || `${path} ${r.status}`);
  return j;
}

export default function TrackPage({ electionId }) {
  const [eid, setEid] = useState(electionId || '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);   // 성공 결과
  const [fail, setFail] = useState('');   // 실패(변조) 메시지

  async function track(rawCode) {
    setBusy(true); setRes(null); setFail('');
    try {
      const prefix = rawCode.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      if (!eid || prefix.length < 4) throw new Error('선거 ID와 추적번호를 입력하세요.');
      const board = await J(`/elections/${encodeURIComponent(eid)}/bulletin-board`);
      const ballots = board.encryptedBallots || [];
      const idx = ballots.findIndex((b) => (b.nullifierHash || '').toLowerCase().startsWith(prefix));
      if (idx < 0) {
        setFail(`추적번호 "${rawCode}"에 해당하는 표를 게시판에서 찾을 수 없습니다. (조작·오타된 번호는 추적되지 않습니다)`);
        setBusy(false); return;
      }
      const ballot = ballots[idx];
      const full = ballot.nullifierHash;
      // Merkle 봉인 검증
      const merkle = await J(`/elections/${encodeURIComponent(eid)}/merkle`);
      const proofResp = await J(`/elections/${encodeURIComponent(eid)}/proof/${full}`);
      const computedRoot = await computeMerkleRootFromProof(proofResp.leafHash, proofResp.proof);
      const sealMatch = computedRoot === merkle.rootHash;
      setRes({
        full, idx, total: ballots.length, ballots,
        leafHash: proofResp.leafHash, chainRoot: merkle.rootHash, computedRoot, sealMatch,
        tallyTotal: board.totalVotes, cipher: ballot.encryptedCandidateID,
      });
    } catch (e) { setFail(e.message); }
    setBusy(false);
  }

  function tamper() {
    // 번호 한 글자 변조 → 추적 실패 시연
    const hex = code.replace(/[^0-9a-fA-F]/g, '');
    if (!hex) return;
    const last = hex[hex.length - 1];
    const flipped = (parseInt(last, 16) ^ 1).toString(16);
    track(hex.slice(0, -1) + flipped);
  }

  const card = { background: '#fff', borderRadius: 14, padding: 20, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,.08)' };
  const big = { background: '#0f172a', color: '#fff', borderRadius: 12, padding: '14px 0', fontSize: 30, fontWeight: 800, letterSpacing: 3, textAlign: 'center' };

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ fontSize: 26 }}>🔎 내 표 추적</h1>
        <p style={{ color: '#64748b', fontSize: 14, marginBottom: 16 }}>택배 송장처럼, 추적번호로 <b>내 표가 변조 없이 집계에 들어갔는지</b> 확인합니다.</p>

        <div style={card}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input value={eid} onChange={(e) => setEid(e.target.value)} placeholder="선거 ID"
              style={{ flex: 2, minWidth: 180, padding: 12, borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 15 }} />
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="추적번호 (예: 7F3A-90)"
              style={{ flex: 1, minWidth: 140, padding: 12, borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 15 }} />
            <button onClick={() => track(code)} disabled={busy}
              style={{ padding: '12px 22px', borderRadius: 10, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
              {busy ? '추적 중...' : '추적하기'}
            </button>
          </div>
        </div>

        {fail && (
          <div style={{ ...card, border: '2px solid #ef4444', background: '#fef2f2' }}>
            <div style={{ fontSize: 40, textAlign: 'center' }}>❌</div>
            <div style={{ color: '#b91c1c', textAlign: 'center', fontWeight: 600 }}>봉인 불일치 / 추적 실패</div>
            <p style={{ color: '#7f1d1d', fontSize: 14, textAlign: 'center', marginTop: 8 }}>{fail}</p>
          </div>
        )}

        {res && (
          <>
            {/* 1. 영수증 */}
            <div style={card}>
              <Step n="1" t="당신의 추적번호" />
              <div style={big}>{code || res.full.slice(0, 6).toUpperCase()}</div>
              <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>이건 당신만 가진 번호입니다.</p>
            </div>

            {/* 2. 게시판에서 내 줄 */}
            <div style={card}>
              <Step n="2" t="공개 게시판에서 '당신의 줄' 찾기" />
              <div style={{ maxHeight: 200, overflow: 'auto', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                {res.ballots.map((b, i) => (
                  <div key={i} style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12,
                    background: i === res.idx ? '#fef9c3' : i % 2 ? '#f8fafc' : '#fff',
                    fontWeight: i === res.idx ? 700 : 400, color: i === res.idx ? '#854d0e' : '#475569',
                    borderLeft: i === res.idx ? '4px solid #eab308' : '4px solid transparent' }}>
                    {i === res.idx ? '➡ ' : '　'}#{i + 1}  {(b.nullifierHash || '').slice(0, 24)}…
                  </div>
                ))}
              </div>
              <p style={{ color: '#854d0e', fontSize: 13, marginTop: 8 }}>↑ {res.idx + 1}번째 줄이 당신의 표입니다 (전체 {res.total}건).</p>
            </div>

            {/* 3. Merkle 봉인 */}
            <div style={card}>
              <Step n="3" t="투표함 봉인 검사 (Merkle)" />
              <Row label="내 표의 지문 (leaf)" val={res.leafHash} />
              <Row label="내가 다시 계산한 봉인" val={res.computedRoot} />
              <Row label="블록체인에 저장된 봉인" val={res.chainRoot} />
              <div style={{ marginTop: 10, padding: 12, borderRadius: 10, fontWeight: 700, textAlign: 'center',
                background: res.sealMatch ? '#dcfce7' : '#fee2e2', color: res.sealMatch ? '#166534' : '#b91c1c' }}>
                {res.sealMatch ? '✅ 봉인 일치 — 내 표를 넣어 다시 계산해도 봉인이 똑같습니다 (아무도 못 건드림)' : '❌ 봉인 불일치 — 변조 감지'}
              </div>
            </div>

            {/* 4. 집계 기여 */}
            <div style={card}>
              <Step n="4" t="집계 기여" />
              <p style={{ fontSize: 16 }}>당신의 표는 최종 <b style={{ fontSize: 22, color: '#2563eb' }}>{res.tallyTotal}</b>표 중 <b>1표</b>로 집계에 포함되었습니다.</p>
            </div>

            {/* 5. 운영자도 못 본다 */}
            <div style={card}>
              <Step n="5" t="운영자도 못 본다 (이 표의 원장 기록 전부)" />
              <Row label="추적번호(단방향 해시)" val={res.full} />
              <Row label="암호문 (c1:c2)" val={res.cipher} />
              <p style={{ marginTop: 8, fontSize: 13 }}>후보? <b style={{ color: '#b91c1c' }}>❌ 불가</b>　이름? <b style={{ color: '#b91c1c' }}>❌ 불가</b> — 개별 표는 시스템이 절대 복호화하지 않고(합계만), 그 합계도 2-of-3 기관 키조각이 모여야 열립니다.</p>
            </div>

            {/* 변조 데모 */}
            <div style={card}>
              <Step n="⚡" t="조작하면? (무결성 데모)" />
              <button onClick={tamper}
                style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #ef4444', background: '#fff', color: '#b91c1c', fontWeight: 700, cursor: 'pointer' }}>
                추적번호 한 글자 바꿔서 다시 추적
              </button>
              <p style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>→ 게시판에서 찾을 수 없어 추적이 실패합니다. 가짜 번호로는 검증을 통과할 수 없습니다.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Step({ n, t }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
    <span style={{ width: 28, height: 28, borderRadius: 999, background: '#2563eb', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14 }}>{n}</span>
    <span style={{ fontWeight: 700, fontSize: 15 }}>{t}</span>
  </div>;
}
function Row({ label, val }) {
  return <div style={{ marginBottom: 6 }}>
    <div style={{ fontSize: 11, color: '#94a3b8' }}>{label}</div>
    <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#334155', wordBreak: 'break-all' }}>{val}</div>
  </div>;
}
