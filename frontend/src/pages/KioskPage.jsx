import { useState, useEffect } from 'react';
import {
  computeNullifier,
  generateVoterSecret,
  elgamalEncrypt,
  generateBallotValidityProof,
} from '../utils/crypto.js';

/**
 * KioskPage — 부스 시연용 폰 투표 전용 화면 (Phase 4)
 * 진입: /?app=kiosk&e=<electionID>  (QR로 접속)
 *
 * 후보 선택 → 투표 → 큰 영수증(추적번호). 인증·암호화·ZKP는 자동.
 */
const API = '/api';

async function J(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json', ...(headers || {}) }, ...rest });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) throw new Error(j.error || `${path} ${r.status}`);
  return j;
}

// 폰별 고유 데모 유권자 ID (localStorage에 유지)
function getDemoVoter() {
  let id = localStorage.getItem('mongbas_demo_voter');
  if (!id) {
    const n = 1 + Math.floor(Math.random() * 100);
    id = `demo${String(n).padStart(3, '0')}`;
    localStorage.setItem('mongbas_demo_voter', id);
  }
  return id;
}

export default function KioskPage({ electionId }) {
  const [election, setElection] = useState(null);
  const [pub, setPub] = useState(null);
  const [bf, setBf] = useState(null);
  const [cred, setCred] = useState(null);
  const [pick, setPick] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | ready | voting | done | error
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    (async () => {
      if (!electionId) { setErr('선거 ID가 없습니다. QR을 다시 스캔하세요.'); setPhase('error'); return; }
      try {
        const el = await J(`/elections/${encodeURIComponent(electionId)}`);
        if (el.status !== 'ACTIVE') { setErr('투표가 마감되었거나 아직 시작되지 않았습니다.'); setPhase('error'); return; }
        setElection(el);
        if (el.encryptionMode === 'elgamal') {
          const pk = await J(`/elections/${encodeURIComponent(electionId)}/elgamal-pubkey`);
          setPub(pk.pubKey);
        }
        const b = await J(`/elections/${encodeURIComponent(electionId)}/blinding-factor`);
        setBf(b.blindingFactor);
        const voter = getDemoVoter();
        const c = await J('/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: voter, enrollmentSecret: `${voter}pw`, electionID: electionId }) });
        setCred(c.credential);
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
        const bvp = generateBallotValidityProof(pub, c1, c2, _r, pick, election.candidates.length);
        body.ballotValidityProof = JSON.stringify(bvp);
      } else {
        body.candidateID = candidateID;
      }
      await J('/vote', { method: 'POST', headers: { 'x-idemix-credential': cred }, body: JSON.stringify(body) });
      const short = nh.slice(0, 6).toUpperCase();
      setReceipt({ code: `${short.slice(0, 4)}-${short.slice(4)}`, full: nh });
      setPhase('done');
    } catch (e) { setErr(e.message); setPhase('error'); }
  }

  const wrap = { minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 20 };

  if (phase === 'loading') return <div style={wrap}><div style={{ marginTop: 120, color: '#64748b' }}>준비 중...</div></div>;
  if (phase === 'error') return <div style={wrap}><div style={{ marginTop: 100, textAlign: 'center', color: '#dc2626' }}><div style={{ fontSize: 40 }}>⚠️</div><p>{err}</p></div></div>;

  if (phase === 'done') return (
    <div style={wrap}>
      <div style={{ marginTop: 40, width: '100%', maxWidth: 380, textAlign: 'center' }}>
        <div style={{ fontSize: 56 }}>✅</div>
        <h2 style={{ margin: '8px 0 4px' }}>투표 완료</h2>
        <p style={{ color: '#64748b', fontSize: 14 }}>내 추적번호 — 검증할 때 사용하세요</p>
        <div style={{ background: '#0f172a', color: '#fff', borderRadius: 16, padding: '24px 0', margin: '16px 0', fontSize: 44, fontWeight: 800, letterSpacing: 4 }}>
          {receipt.code}
        </div>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>이 번호로 "내 표가 집계에 들어갔는지"를 변조 없이 확인할 수 있습니다.<br />(누구에게 투표했는지는 드러나지 않습니다)</p>
      </div>
    </div>
  );

  // ready / voting
  return (
    <div style={wrap}>
      <div style={{ width: '100%', maxWidth: 380, marginTop: 20 }}>
        <h1 style={{ fontSize: 22, textAlign: 'center' }}>{election.title}</h1>
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, marginBottom: 20 }}>익명 투표 · 서버는 암호문만 봅니다</p>
        {election.candidates.map((c, i) => (
          <button key={c} onClick={() => setPick(i)} disabled={phase === 'voting'}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '18px 20px', marginBottom: 12, borderRadius: 14, fontSize: 18, fontWeight: 600,
              border: pick === i ? '2px solid #2563eb' : '2px solid #e2e8f0', background: pick === i ? '#eff6ff' : '#fff', color: '#0f172a', cursor: 'pointer' }}>
            <span style={{ display: 'inline-block', width: 26, height: 26, borderRadius: 999, border: pick === i ? '8px solid #2563eb' : '2px solid #cbd5e1', marginRight: 12, verticalAlign: 'middle' }} />
            기호 {i + 1}　{c}
          </button>
        ))}
        <button onClick={vote} disabled={pick == null || phase === 'voting'}
          style={{ width: '100%', padding: 18, marginTop: 8, borderRadius: 14, border: 'none', fontSize: 19, fontWeight: 800, color: '#fff',
            background: pick == null ? '#cbd5e1' : '#2563eb', cursor: pick == null ? 'not-allowed' : 'pointer' }}>
          {phase === 'voting' ? '암호화 + 제출 중...' : '투표하기'}
        </button>
      </div>
    </div>
  );
}
