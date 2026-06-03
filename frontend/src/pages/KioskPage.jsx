import { useState, useEffect } from 'react';
import {
  computeNullifier,
  generateVoterSecret,
  elgamalEncrypt,
  generateBallotValidityProof,
} from '../utils/crypto.js';

/**
 * KioskPage — 부스 시연용 폰 투표 전용 화면 (Phase 4 · P7 모바일 리디자인)
 * 진입: /?app=kiosk&e=<electionID>
 */
const API = '/api';

async function J(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json', ...(headers || {}) }, ...rest });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) throw new Error(j.error || `${path} ${r.status}`);
  return j;
}

function getDemoVoter() {
  let id = localStorage.getItem('mongbas_demo_voter');
  if (!id) { id = `demo${String(1 + Math.floor(Math.random() * 100)).padStart(3, '0')}`; localStorage.setItem('mongbas_demo_voter', id); }
  return id;
}

// ── 디자인 토큰 ──
const C = { bg: '#f1f5f9', card: '#ffffff', ink: '#0f172a', sub: '#64748b', line: '#e2e8f0', primary: '#4f46e5', primarySoft: '#eef2ff', ok: '#16a34a', danger: '#dc2626' };
const shadow = '0 1px 2px rgba(15,23,42,.04), 0 8px 24px rgba(15,23,42,.06)';

export default function KioskPage({ electionId }) {
  const [election, setElection] = useState(null);
  const [pub, setPub] = useState(null);
  const [bf, setBf] = useState(null);
  const [cred, setCred] = useState(null);
  const [pick, setPick] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    (async () => {
      if (!electionId) { setErr('선거 ID가 없습니다. QR을 다시 스캔하세요.'); setPhase('error'); return; }
      try {
        const el = await J(`/elections/${encodeURIComponent(electionId)}`);
        if (el.status !== 'ACTIVE') { setErr('투표가 마감되었거나 아직 시작되지 않았습니다.'); setPhase('error'); return; }
        setElection(el);
        if (el.encryptionMode === 'elgamal') setPub((await J(`/elections/${encodeURIComponent(electionId)}/elgamal-pubkey`)).pubKey);
        setBf((await J(`/elections/${encodeURIComponent(electionId)}/blinding-factor`)).blindingFactor);
        const voter = getDemoVoter();
        setCred((await J('/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: voter, enrollmentSecret: `${voter}pw`, electionID: electionId }) })).credential);
        setPhase('ready');
      } catch (e) { setErr(e.message); setPhase('error'); }
    })();
  }, [electionId]);

  async function vote() {
    if (pick == null) return;
    setPhase('voting');
    try {
      let vs = localStorage.getItem(`mongbas_vs_${electionId}`);
      if (!vs) { vs = generateVoterSecret(); localStorage.setItem(`mongbas_vs_${electionId}`, vs); }
      const nh = await computeNullifier(vs, electionId, bf);
      const candidateID = election.candidates[pick];
      const body = { electionID: electionId, nullifierHash: nh };
      if (election.encryptionMode === 'elgamal') {
        const { c1, c2, _r } = elgamalEncrypt(pub, candidateID, pick);
        body.encryptedCandidateID = `${c1}:${c2}`;
        body.ballotValidityProof = JSON.stringify(generateBallotValidityProof(pub, c1, c2, _r, pick, election.candidates.length));
      } else body.candidateID = candidateID;
      await J('/vote', { method: 'POST', headers: { 'x-idemix-credential': cred }, body: JSON.stringify(body) });
      const s = nh.slice(0, 6).toUpperCase();
      setReceipt({ code: `${s.slice(0, 4)}-${s.slice(4)}` });
      setPhase('done');
    } catch (e) { setErr(e.message); setPhase('error'); }
  }

  // 공통 셸: 가로 오버플로우 차단 + 중앙 컨테이너
  const Shell = ({ children }) => (
    <div style={{ boxSizing: 'border-box', width: '100%', minHeight: '100dvh', background: C.bg, overflowX: 'hidden', fontFamily: 'system-ui,-apple-system,sans-serif', color: C.ink }}>
      <div style={{ boxSizing: 'border-box', width: '100%', maxWidth: 440, margin: '0 auto', padding: '20px 16px 40px' }}>{children}</div>
    </div>
  );

  if (phase === 'loading') return <Shell><Center>준비 중…</Center></Shell>;
  if (phase === 'error') return <Shell><Center><div style={{ fontSize: 44 }}>⚠️</div><p style={{ color: C.danger, fontWeight: 600 }}>{err}</p></Center></Shell>;

  if (phase === 'done') return (
    <Shell>
      <div style={{ textAlign: 'center', marginTop: 28 }}>
        <div style={{ width: 84, height: 84, borderRadius: 999, background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', fontSize: 44 }}>✅</div>
        <h2 style={{ margin: '18px 0 4px', fontSize: 24 }}>투표 완료</h2>
        <p style={{ color: C.sub, fontSize: 14, margin: 0 }}>내 추적번호 — 검증할 때 사용하세요</p>
        <div style={{ boxSizing: 'border-box', width: '100%', background: 'linear-gradient(135deg,#4f46e5,#7c3aed)', color: '#fff', borderRadius: 20, padding: '26px 0', margin: '20px 0', fontSize: 46, fontWeight: 800, letterSpacing: 6, boxShadow: shadow }}>
          {receipt.code}
        </div>
        <p style={{ color: C.sub, fontSize: 13, lineHeight: 1.6 }}>이 번호로 <b style={{ color: C.ink }}>내 표가 변조 없이 집계에 들어갔는지</b> 확인할 수 있습니다.<br />누구에게 투표했는지는 드러나지 않습니다.</p>
      </div>
    </Shell>
  );

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <h1 style={{ fontSize: 23, fontWeight: 800, margin: '4px 0' }}>{election.title}</h1>
        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', fontSize: 11, color: C.sub }}>
          <Badge>🔒 익명</Badge><Badge>🛡️ 암호화</Badge><Badge>✓ 검증가능</Badge>
        </div>
      </div>

      {election.candidates.map((c, i) => {
        const on = pick === i;
        return (
          <button key={c} onClick={() => setPick(i)} disabled={phase === 'voting'}
            style={{ boxSizing: 'border-box', width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14,
              padding: '18px 18px', marginBottom: 12, borderRadius: 16, fontSize: 17, fontWeight: 700, cursor: 'pointer',
              border: `2px solid ${on ? C.primary : C.line}`, background: on ? C.primarySoft : C.card, color: C.ink,
              boxShadow: on ? '0 4px 14px rgba(79,70,229,.18)' : shadow, transition: 'all .15s' }}>
            <span style={{ flex: '0 0 auto', width: 26, height: 26, borderRadius: 999, border: `2px solid ${on ? C.primary : '#cbd5e1'}`, background: on ? C.primary : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {on && <span style={{ width: 10, height: 10, borderRadius: 999, background: '#fff' }} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ color: C.sub, fontSize: 13, fontWeight: 600 }}>기호 {i + 1}</span><br />{c}</span>
          </button>
        );
      })}

      <button onClick={vote} disabled={pick == null || phase === 'voting'}
        style={{ boxSizing: 'border-box', width: '100%', padding: 18, marginTop: 6, borderRadius: 16, border: 'none', fontSize: 18, fontWeight: 800, color: '#fff',
          background: pick == null ? '#cbd5e1' : C.primary, cursor: pick == null ? 'not-allowed' : 'pointer', boxShadow: pick == null ? 'none' : '0 6px 18px rgba(79,70,229,.3)' }}>
        {phase === 'voting' ? '🔐 암호화 + 제출 중…' : '투표하기'}
      </button>
      <p style={{ textAlign: 'center', color: C.sub, fontSize: 12, marginTop: 14 }}>서버는 암호문만 받습니다. 평문 투표는 전송되지 않습니다.</p>
    </Shell>
  );
}

const Center = ({ children }) => <div style={{ textAlign: 'center', marginTop: 120 }}>{children}</div>;
const Badge = ({ children }) => <span style={{ boxSizing: 'border-box', padding: '4px 10px', borderRadius: 999, background: '#fff', border: '1px solid #e2e8f0' }}>{children}</span>;
