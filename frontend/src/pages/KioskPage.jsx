import { useState, useEffect } from 'react';
import {
  sha256,
  computeNullifier,
  elgamalEncrypt,
  generateBallotValidityProof,
  generateVectorBallotV3,
} from '../utils/crypto.js';
import { browserCryptoReady } from '../utils/kioskUrl.js';

/**
 * KioskPage — 부스 시연용 폰 투표 (Editorial Cobalt · 라이트)
 * 진입: /?app=kiosk&e=<electionID>
 *  · 후보 선택 → 단말 암호화 + ZKP → 제출(서버는 암호문만)
 *  · 투표 완료 후 [검증하기] = 대시보드(관제판)에 실제 검증 화면을 띄움(이벤트 버스)
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
  // Session scope avoids leaving a durable demo credential identifier on the phone.
  localStorage.removeItem('mongbas_demo_voter');
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('mongbas_hist_')) localStorage.removeItem(key);
  }
  let id = sessionStorage.getItem('mongbas_demo_voter');
  if (!id) { id = `demo${String(1 + Math.floor(Math.random() * 100)).padStart(3, '0')}`; sessionStorage.setItem('mongbas_demo_voter', id); }
  return id;
}

const C = {
  font: '"Pretendard Variable",Pretendard,-apple-system,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif',
  bg: '#f5f7ff', card: '#ffffff', ink: '#0a0f24', sub: '#54607a', line: '#d7dcfb', blue: '#2440F2', blueD: '#1A2BC9', soft: '#eef1ff',
};

export default function KioskPage({ electionId }) {
  const [election, setElection] = useState(null);
  const [pub, setPub] = useState(null);
  const [bf, setBf] = useState(null);
  const [cred, setCred] = useState(null);
  const [nullifierMaterial, setNullifierMaterial] = useState(null);
  const [pick, setPick] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState(null);  // { code, nh }
  const [sent, setSent] = useState(false);
  const [mode, setMode] = useState(null);        // 'real' | 'panic' (강압 저항 데모 트리거)

  useEffect(() => {
    (async () => {
      if (!electionId) { setErr('선거 ID가 없습니다. QR을 다시 스캔하세요.'); setPhase('error'); return; }
      if (!browserCryptoReady(window)) { setErr('이 투표 화면은 HTTPS 보안 연결과 Web Crypto가 필요합니다. QR URL을 확인하세요.'); setPhase('error'); return; }
      try {
        const el = await J(`/elections/${encodeURIComponent(electionId)}`);
        if (el.status !== 'ACTIVE') { setErr('투표가 마감되었거나 아직 시작되지 않았습니다.'); setPhase('error'); return; }
        setElection(el);
        if (el.encryptionMode === 'elgamal' || el.encryptionMode === 'elgamal-vector-v3') setPub((await J(`/elections/${encodeURIComponent(electionId)}/elgamal-pubkey`)).pubKey);
        setBf((await J(`/elections/${encodeURIComponent(electionId)}/blinding-factor`)).blindingFactor);
        const voter = getDemoVoter();
        const issued = await J('/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: voter, enrollmentSecret: `${voter}pw`, electionID: electionId }) });
        if (!issued.credential || !issued.nullifierMaterial) throw new Error('자격증명 nullifier 바인딩 재료가 누락됐습니다.');
        setCred(issued.credential);
        setNullifierMaterial(issued.nullifierMaterial);
        setPhase('choose');
      } catch (e) { setErr(e.message); setPhase('error'); }
    })();
  }, [electionId]);

  async function vote() {
    if (pick == null) return;
    setPhase('voting');
    try {
      const nh = await computeNullifier(nullifierMaterial, electionId, bf);
      const candidateID = election.candidates[pick];
	  const body = { electionID: electionId, nullifierHash: nh, credentialType: mode === 'panic' ? 'panic' : 'real' };
	  let vectorClientNonce = '';
	  if (election.encryptionMode === 'elgamal-vector-v3') {
		const vectorBallot = generateVectorBallotV3(pub, pick, election.candidates.length);
		body.encryptedCandidateVector = vectorBallot.encryptedCandidateVector;
		body.vectorBallotValidityProof = vectorBallot.vectorBallotValidityProof;
		const nonceBytes = new Uint8Array(32);
		crypto.getRandomValues(nonceBytes);
		vectorClientNonce = Array.from(nonceBytes, b => b.toString(16).padStart(2, '0')).join('');
	  } else if (election.encryptionMode === 'elgamal') {
        const { c1, c2, _r } = elgamalEncrypt(pub, candidateID, pick);
        body.encryptedCandidateID = `${c1}:${c2}`;
        body.ballotValidityProof = JSON.stringify(generateBallotValidityProof(pub, c1, c2, _r, pick, election.candidates.length));
      } else body.candidateID = candidateID;
      let votePath = '/vote';
	  if (election.encryptionMode === 'elgamal-vector-v3') {
		const prepared = await J('/vote/prepare-vector', { method: 'POST', headers: { 'x-idemix-credential': cred },
		  body: JSON.stringify({ ...body, clientNonceHash: await sha256(vectorClientNonce) }) });
		if (!prepared.ballotID) throw new Error('vector-v3 준비 영수증이 누락됐습니다.');
		body.ballotID = prepared.ballotID;
		votePath = '/vote/cast-vector';
	  }
      const resp = await J(votePath, { method: 'POST', headers: { 'x-idemix-credential': cred }, body: JSON.stringify(body) });
      const s = nh.slice(0, 6).toUpperCase();
      // Never persist the selected candidate or normal/panic mode on the device.
      setReceipt({ code: `${s.slice(0, 4)}-${s.slice(4)}`, nh, isRevote: !!resp.isRevote });
      setSent(false);
      setPhase('done');
    } catch (e) { setErr(e.message); setPhase('error'); }
  }

  // 대시보드(관제판)에 실제 검증 화면을 띄움
  async function verifyOnDashboard() {
    try {
      await J('/vote/demo-event', { method: 'POST', headers: { 'x-idemix-credential': cred },
        body: JSON.stringify({ electionID: electionId, nullifierHash: receipt.nh }) });
      setSent(true);
    } catch (e) { setErr(e.message); }
  }

  const Shell = ({ children }) => (
    <div style={{ width: '100%', minHeight: '100dvh', background: C.bg, overflowX: 'hidden', fontFamily: C.font, color: C.ink, letterSpacing: '-0.02em', wordBreak: 'keep-all', boxSizing: 'border-box' }}>
      <div style={{ width: '100%', maxWidth: 440, margin: '0 auto', padding: '22px 16px 44px', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
          <img src="/logo/mongbas-symbol-blue.svg" alt="" style={{ width: 24, height: 24 }} />
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: '-0.05em' }}>MONGBAS</span>
        </div>
        {children}
      </div>
    </div>
  );

  if (phase === 'loading') return <Shell><Center>준비 중…</Center></Shell>;
  if (phase === 'error') return <Shell><Center><div style={{ fontSize: 40 }}>⚠️</div><p style={{ color: C.blueD, fontWeight: 800, marginTop: 10 }}>{err}</p></Center></Shell>;

  if (phase === 'done') return (
    <Shell>
      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <div style={{ width: 78, height: 78, background: C.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', color: '#fff', fontSize: 40, fontWeight: 900 }}>✓</div>
        <h2 style={{ margin: '18px 0 4px', fontSize: 26, fontWeight: 900, letterSpacing: '-0.04em' }}>{receipt.isRevote ? '재투표 완료' : '투표 완료'}</h2>
        <p style={{ color: C.sub, fontSize: 13.5, margin: 0, fontWeight: 700 }}>{receipt.isRevote ? '이전 표가 대체됐습니다 — 마지막 표만 유효' : '내 추적번호 — 검증할 때 사용하세요'}</p>
        <div style={{ width: '100%', background: C.blue, color: '#fff', padding: '26px 0', margin: '18px 0', fontSize: 46, fontWeight: 900, letterSpacing: 6, boxSizing: 'border-box', fontFamily: 'monospace' }}>
          {receipt.code}
        </div>
        <p style={{ color: C.sub, fontSize: 13, lineHeight: 1.6, fontWeight: 600 }}>이 번호로 <b style={{ color: C.ink }}>내 표가 변조 없이 집계에 들어갔는지</b> 확인할 수 있습니다. 누구에게 투표했는지는 드러나지 않습니다.</p>
        <button onClick={() => { setPick(null); setMode(null); setSent(false); setPhase('choose'); }}
          style={{ width: '100%', marginTop: 4, marginBottom: 8, padding: 15, border: `2px solid ${C.line}`, background: '#fff', color: C.ink, fontSize: 15, fontWeight: 900, fontFamily: 'inherit', cursor: 'pointer', boxSizing: 'border-box' }}>
          ↺ 다시 투표하기 <span style={{ fontWeight: 700, color: C.sub, fontSize: 12 }}>(마지막 표만 유효)</span>
        </button>
        {sent ? (
          <div style={{ marginTop: 14, padding: 16, border: `1.5px solid ${C.blue}`, background: C.soft, color: C.blueD, fontWeight: 800, fontSize: 14 }}>
            ✓ 관제판 화면에서 <b>내 표 검증</b>이 진행됩니다.<br />큰 화면을 확인하세요.
          </div>
        ) : (
          <button onClick={verifyOnDashboard}
            style={{ width: '100%', marginTop: 8, padding: 17, border: `2px solid ${C.blue}`, background: '#fff', color: C.blue, fontSize: 16, fontWeight: 900, fontFamily: 'inherit', cursor: 'pointer', boxSizing: 'border-box' }}>
            관제판에서 검증하기 ↗
          </button>
        )}
        <p style={{ color: C.sub, fontSize: 11.5, marginTop: 10, fontWeight: 600 }}>※ 게시판은 개표(종료) 후 공개됩니다.</p>
      </div>
    </Shell>
  );

  // 강압 저항 데모 트리거 — 고른 뒤 화면·영수증·검증은 두 모드가 100% 동일
  if (phase === 'choose') return (
    <Shell>
      <h1 style={{ fontSize: 24, fontWeight: 900, margin: '4px 0 6px', letterSpacing: '-0.04em' }}>{election.title}</h1>
      <p style={{ color: C.sub, fontSize: 13.5, fontWeight: 700, margin: '0 0 18px' }}>어떻게 투표할까요?</p>
      <button onClick={() => { setMode('real'); setPhase('ready'); }}
        style={{ width: '100%', textAlign: 'left', padding: '20px 18px', marginBottom: 12, border: `2px solid ${C.blue}`, background: C.blue, color: '#fff', fontFamily: 'inherit', cursor: 'pointer', boxSizing: 'border-box' }}>
        <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-0.03em' }}>정상 투표</div>
        <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.9, marginTop: 4 }}>내 의사대로 한 표 — 집계에 반영됩니다</div>
      </button>
      <button onClick={() => { setMode('panic'); setPhase('ready'); }}
        style={{ width: '100%', textAlign: 'left', padding: '20px 18px', border: `2px solid ${C.blue}`, background: '#fff', color: C.ink, fontFamily: 'inherit', cursor: 'pointer', boxSizing: 'border-box' }}>
        <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-0.03em', color: C.blue }}>패닉(강압) 투표</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.sub, marginTop: 4 }}>강압 상황을 가정한 연구용 필터링 데모입니다</div>
      </button>
      <p style={{ textAlign: 'center', color: C.sub, fontSize: 11.5, marginTop: 16, fontWeight: 600, lineHeight: 1.5 }}>현재 화면 동작만으로 강압 저항이 검증된 것은 아닙니다.<br />네트워크·시간·기관 공모 공격 평가가 추가로 필요합니다.</p>
    </Shell>
  );

  return (
    <Shell>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 900, margin: '2px 0 8px', letterSpacing: '-0.04em' }}>{election.title}</h1>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <Badge>익명</Badge><Badge>암호화</Badge><Badge>검증가능</Badge>
        </div>
      </div>

      {election.candidates.map((c, i) => {
        const on = pick === i;
        return (
          <button key={c} onClick={() => setPick(i)} disabled={phase === 'voting'}
            style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: '17px 16px', marginBottom: 11,
              fontSize: 17, fontWeight: 900, cursor: 'pointer', boxSizing: 'border-box', fontFamily: 'inherit', letterSpacing: '-0.02em',
              border: `2px solid ${on ? C.blue : C.line}`, background: on ? C.soft : C.card, color: C.ink, transition: 'all .12s' }}>
            <span style={{ flex: '0 0 auto', width: 24, height: 24, borderRadius: 999, border: `2px solid ${on ? C.blue : '#b9c2e6'}`, background: on ? C.blue : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {on && <span style={{ width: 9, height: 9, borderRadius: 999, background: '#fff' }} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}><span style={{ color: C.sub, fontSize: 12.5, fontWeight: 800 }}>기호 {i + 1}</span><br />{c}</span>
          </button>
        );
      })}

      <button onClick={vote} disabled={pick == null || phase === 'voting'}
        style={{ width: '100%', padding: 18, marginTop: 6, border: 'none', fontSize: 18, fontWeight: 900, color: '#fff', fontFamily: 'inherit', boxSizing: 'border-box',
          background: pick == null ? '#c2c9e6' : C.blue, cursor: pick == null ? 'not-allowed' : 'pointer', letterSpacing: '-0.02em' }}>
        {phase === 'voting' ? '🔒 암호화 + 제출 중…' : '투표하기'}
      </button>
      <p style={{ textAlign: 'center', color: C.sub, fontSize: 12, marginTop: 14, fontWeight: 600 }}>서버는 암호문만 받습니다. 평문 투표는 전송되지 않습니다.</p>
    </Shell>
  );
}

const Center = ({ children }) => <div style={{ textAlign: 'center', marginTop: 120 }}>{children}</div>;
function Badge({ children }) {
  return <span style={{ fontSize: 12, fontWeight: 900, color: C.blue, border: `1.5px solid ${C.line}`, background: '#fff', padding: '6px 11px' }}>{children}</span>;
}
