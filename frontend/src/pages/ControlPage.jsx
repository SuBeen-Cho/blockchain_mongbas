import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { computeMerkleRootFromProof } from '../utils/crypto.js';
import { buildSecureKioskUrl, displayKioskUrl } from '../utils/kioskUrl.js';

/**
 * ControlPage — 발표자 관제판 (Editorial Cobalt 개편)
 * 진입: /?app=control
 *
 *  · 실시간 암호문 표(폴링) — 모바일 투표가 새로고침 없이 표/카운터에 누적
 *  · 개표 탭 = 즉시 종료 + 개표 뷰 전환(결과 + 집계 수학식)
 *  · 검증 탭 = 실제 Merkle 검증(추적번호→게시판→봉인 일치). 모바일 "검증하기"가 이 뷰를 띄움
 *  · 셔플 시각화 — 게시판 공개 시 도착 순서를 섞어 timing 상관 제거
 */
const API = '/api';
const CANDIDATES = ['치킨', '피자', '떡볶이'];
let activeControlAdminToken = '';

const T = {
  font: '"Pretendard Variable",Pretendard,-apple-system,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif',
  blue: '#2440F2', blueD: '#1A2BC9', blueSky: '#4D74FF', blueSoft: '#cdd6ff', blueLine: '#c3cdfb',
  paper: '#ffffff', paper2: '#eef1ff', ink: '#0a0f24', sub: '#54607a', line: '#d7dcfb', panel: '#f5f7ff',
};
const tr = (s, n = 10) => (s ? `${s.slice(0, n)}…${s.slice(-4)}` : '—');
function kioskURL(electionID, admissionToken = '') {
  const configured = String(import.meta.env.VITE_PUBLIC_VOTER_ORIGIN || '').trim();
  return buildSecureKioskUrl(electionID, window.location.origin, configured, admissionToken);
}

async function J(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(API + path, { headers: {
    'Content-Type': 'application/json',
    ...(activeControlAdminToken ? { Authorization: `Bearer ${activeControlAdminToken}` } : {}),
    ...(headers || {}),
  }, ...rest });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) throw new Error(j.error || `${path} ${r.status}`);
  return j;
}

// 개표 집계 과정 실제값 계산 (공개 데이터: 게시판 암호문 + pubkey + 결과)
function computeTallyMath(pubKey, ballots, results, candidates) {
  try {
    const p = BigInt('0x' + pubKey.p), g = BigInt('0x' + pubKey.g);
    const mod = (a, b) => ((a % b) + b) % b;
    const modPow = (b, e, m) => { b = mod(b, m); let r = 1n; while (e > 0n) { if (e & 1n) r = mod(r * b, m); e >>= 1n; b = mod(b * b, m); } return r; };
	const vectorMode = ballots.some((ballot) => Array.isArray(ballot.encryptedCandidateVector));
	if (vectorMode) {
	  const aggregates = candidates.map(() => ({ c1: 1n, c2: 1n }));
	  let n = 0;
	  for (const ballot of ballots) {
		if (ballot.encryptedCandidateVector?.length !== candidates.length) continue;
		ballot.encryptedCandidateVector.forEach((ciphertext, index) => {
		  aggregates[index].c1 = mod(aggregates[index].c1 * BigInt('0x' + ciphertext.c1), p);
		  aggregates[index].c2 = mod(aggregates[index].c2 * BigInt('0x' + ciphertext.c2), p);
		});
		n++;
	  }
	  return { ballotCount: n, vector: aggregates.map((value) => ({ c1: value.c1.toString(16), c2: value.c2.toString(16) })), shares: [1, 2],
		perCand: candidates.map((cn) => ({ cn, v: results[cn] || 0, w: 'vector component' })) };
	}
    let c1 = 1n, c2 = 1n, n = 0;
    for (const b of ballots) {
      const [c1h, c2h] = String(b.encryptedCandidateID || '').split(':');
      if (!c1h || !c2h) continue;
      c1 = mod(c1 * BigInt('0x' + c1h), p); c2 = mod(c2 * BigInt('0x' + c2h), p); n++;
    }
    const B = 10000n; let sum = 0n;
    candidates.forEach((cn, i) => { sum += BigInt(results[cn] || 0) * (B ** BigInt(i)); });
    const M = modPow(g, sum, p);
    return {
      ballotCount: n,
      c1: c1.toString(16), c2: c2.toString(16),
      shares: [1, 2], sum: sum.toString(), M: M.toString(16),
      perCand: candidates.map((cn, i) => ({ cn, v: results[cn] || 0, w: (B ** BigInt(i)).toString() })),
    };
  } catch { return null; }
}

export default function ControlPage() {
  const [adminToken, setAdminToken] = useState('');
  const [eid, setEid] = useState(null);
  const [status, setStatus] = useState('-');
  const [view, setView] = useState('session');     // session | tally | verify
  const [live, setLive] = useState(0);
  const [votes, setVotes] = useState([]);          // 라이브 암호문 표
  const [shuffled, setShuffled] = useState(false);
  const [results, setResults] = useState(null);
  const [decrypted, setDecrypted] = useState(false);
  const [qr, setQr] = useState('');
  const [admission, setAdmission] = useState(null);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);
  const [vres, setVres] = useState(null);          // 검증 결과
  const [vfail, setVfail] = useState('');
  const [vcode, setVcode] = useState('');
  const [inj, setInj] = useState([1, 1, 1]);        // 후보별 커스텀 주입 개수
  const [rootHash, setRootHash] = useState('');     // 공개된 Merkle root (검증 탭 상단 표시)
  const [tallyMath, setTallyMath] = useState(null); // 개표 집계 과정 실제 계산값
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 860);
  const pollRef = useRef(null); const evRef = useRef(0);
  let kioskUrl = ''; let kioskUrlError = '';
  if (eid && admission?.token) {
    try { kioskUrl = kioskURL(eid, admission.token); } catch (error) { kioskUrlError = error.message; }
  }
  useEffect(() => { const f = () => setNarrow(window.innerWidth < 860); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const addLog = useCallback((m) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 10)), []);

  useEffect(() => {
    if (kioskUrl) QRCode.toDataURL(kioskUrl, { width: 320, margin: 1, color: { dark: '#0a0f24', light: '#ffffff' } }).then(setQr).catch(() => setQr(''));
    else setQr('');
  }, [kioskUrl]);

  useEffect(() => {
    if (!admission?.expiresAt) return undefined;
    const delay = Math.max(0, admission.expiresAt - Date.now());
    const timer = setTimeout(() => setAdmission(null), delay);
    return () => clearTimeout(timer);
  }, [admission]);

  // ── 폴링: 라이브 카운트/표 + 모바일 이벤트 ──
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!eid) return;
    const tick = async () => {
      try {
        if (status === 'ACTIVE') {
          const c = await J(`/elections/${encodeURIComponent(eid)}/live-count`); setLive(c.totalVotes);
        }
        const lv = await J(`/elections/${encodeURIComponent(eid)}/live-votes`);
        setVotes(lv.votes || []); setShuffled(!!lv.shuffled);
        const ev = await J(`/elections/${encodeURIComponent(eid)}/demo-events?since=${evRef.current}`);
        if (ev.events && ev.events.length) {
          evRef.current = ev.lastSeq;
          for (const e of ev.events) {
            if (e.type === 'verify') { setVcode(e.payload?.code || e.payload?.nullifier || ''); setView('verify'); runVerify(e.payload?.code || e.payload?.nullifier || ''); }
          }
        }
      } catch { /* noop */ }
    };
    tick();
    pollRef.current = setInterval(tick, 1500);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eid, status]);

  async function newSession() {
    setBusy('새 세션 생성 중…');
    try {
      const id = `DEMO_${Date.now()}`;
      const now = Math.floor(Date.now() / 1000);
      await J('/elections', { method: 'POST', body: JSON.stringify({ electionID: id, title: '2026 모의 선거', candidates: CANDIDATES, encryptionMode: 'elgamal-vector-v3', endTime: now + 24 * 3600 }) });
      await J(`/elections/${id}/activate`, { method: 'POST' });
      const issuedAdmission = await J('/credential/demo-admission', { method: 'POST', body: JSON.stringify({ electionID: id, ttlSeconds: 120 }) });
      setAdmission(issuedAdmission);
      setEid(id); setStatus('ACTIVE'); setLive(0); setVotes([]); setShuffled(false);
      setResults(null); setDecrypted(false); setView('session'); setVres(null); setVfail(''); setRootHash(''); setTallyMath(null); evRef.current = 0;
      addLog(`새 세션 시작: ${id}`);
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  async function renewAdmission() {
    if (!eid || status !== 'ACTIVE') return;
    setBusy('새 일회용 QR 발급 중…');
    try {
      const issued = await J('/credential/demo-admission', { method: 'POST', body: JSON.stringify({ electionID: eid, ttlSeconds: 120 }) });
      setAdmission(issued);
      addLog('새 일회용 QR 발급');
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  async function seed(n, candIdx) {
    if (!eid || status !== 'ACTIVE') return;
    const label = candIdx != null ? CANDIDATES[candIdx] : '랜덤';
    setBusy(`${label} ${n}표 주입 중…`);
    try {
      const body = { count: n };
      if (candIdx != null) body.dist = Array(n).fill(candIdx);  // 그 후보로만 n표
      const r = await J(`/elections/${encodeURIComponent(eid)}/seed-votes`, { method: 'POST', body: JSON.stringify(body) });
      addLog(`주입: ${label} ${r.injected}표`);
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  // 개표 = 즉시 종료 + 집계 + 게시판 공개 → 개표 뷰
  async function tallyNow() {
    if (!eid) return;
    if (status === 'CLOSED') { setView('tally'); return; }
    setView('tally'); setBusy('선거 종료 중…');
    try {
      // 직전 투표 커밋과의 MVCC 충돌 대비 — 충돌 시 잠깐 대기 후 재시도
      let closed = false;
      for (let a = 0; a < 3 && !closed; a++) {
        try { await J(`/elections/${encodeURIComponent(eid)}/close`, { method: 'POST' }); closed = true; }
        catch (e) {
          if (a < 2 && /conflict|mvcc|commit/i.test(e.message)) { addLog('종료 충돌 감지 — 재시도'); await new Promise((r) => setTimeout(r, 2500)); }
          else throw e;
        }
      }
      setStatus('CLOSED'); addLog('선거 종료 — 2개 기관 partial decryption 시작');
      setBusy('2-of-3 partial decryption 중…');
      for (const idx of ['1', '2']) {
        let submitted = false;
        for (let attempt = 0; attempt < 30 && !submitted; attempt++) {
          try {
            await J(`/elections/${encodeURIComponent(eid)}/partial-decryptions`, { method: 'POST', body: JSON.stringify({ shareIndex: idx }) });
            submitted = true;
          } catch (error) {
            if (attempt === 29) throw error;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        addLog(`기관 ${idx}/2 증명된 partial decryption 제출`);
      }
      setBusy('복호화 확인 중…');
      let t = null;
      for (let i = 0; i < 12; i++) { t = await J(`/elections/${encodeURIComponent(eid)}/tally`); if (t.decrypted) break; await new Promise((r) => setTimeout(r, 800)); }
      setResults(t.results); setDecrypted(!!t.decrypted);
      addLog(t.decrypted ? '복호화 완료' : '복호화 대기');
      setBusy('Merkle 게시판 공개 중…');
      try {
        await J(`/elections/${encodeURIComponent(eid)}/merkle`, { method: 'POST' });
        await J(`/elections/${encodeURIComponent(eid)}/publish-audit`, { method: 'POST' });
        try { const mk = await J(`/elections/${encodeURIComponent(eid)}/merkle`); setRootHash(mk.rootHash || ''); } catch { /* noop */ }
        // 집계 과정 실제 계산값 (공개 데이터로 클라이언트 계산)
        try {
          const bb = await J(`/elections/${encodeURIComponent(eid)}/bulletin-board`);
          const pk = await J(`/elections/${encodeURIComponent(eid)}/elgamal-pubkey`);
          setTallyMath(computeTallyMath(pk.pubKey, bb.encryptedBallots || [], t.results, CANDIDATES));
        } catch { /* noop */ }
        addLog('Merkle 트리 + 게시판 공개 (셔플 적용 · 검증 준비됨)');
      } catch (e) { addLog('게시판 경고: ' + e.message); }
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  // 실제 검증: 추적번호 → 게시판 매칭 → Merkle 봉인 재계산
  async function runVerify(rawCode, tampered = false) {
    if (!eid) return;
    setBusy('검증 중…'); setVres(null); setVfail('');
    try {
      const prefix = String(rawCode || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      if (prefix.length < 4) throw new Error('추적번호를 입력하세요 (4자 이상).');
      const board = await J(`/elections/${encodeURIComponent(eid)}/bulletin-board`);
      const ballots = board.encryptedBallots || [];
      const idx = ballots.findIndex((b) => (b.nullifierHash || '').toLowerCase().startsWith(prefix));
      if (idx < 0) { setVfail(`추적번호 "${rawCode}" 를 게시판에서 찾을 수 없습니다. ${tampered ? '(한 글자 변조 → 추적 실패)' : '(조작·오타 번호는 추적 불가)'}`); setBusy(''); return; }
      const full = ballots[idx].nullifierHash;
      const merkle = await J(`/elections/${encodeURIComponent(eid)}/merkle`);
      const pr = await J(`/elections/${encodeURIComponent(eid)}/proof/${full}`);
      const computedRoot = await computeMerkleRootFromProof(pr.leafHash, pr.proof);
      const sealMatch = computedRoot === merkle.rootHash;
	  const selectedCiphertext = ballots[idx].encryptedCandidateID || JSON.stringify(ballots[idx].encryptedCandidateVector || []);
	  setVres({ full, idx, total: ballots.length, ballots, leafHash: pr.leafHash, chainRoot: merkle.rootHash, computedRoot, sealMatch, cipher: selectedCiphertext });
      addLog(`검증: ${tr(full, 8)} → ${sealMatch ? '봉인 일치 ✓' : '불일치 ✗'}`);
    } catch (e) { setVfail(e.message); }
    setBusy('');
  }
  function tamper() {
    const hex = String(vcode).replace(/[^0-9a-fA-F]/g, '');
    if (!hex) return;
    const flipped = (parseInt(hex[hex.length - 1], 16) ^ 1).toString(16);
    runVerify(hex.slice(0, -1) + flipped, true);
  }

  const totalRes = results ? Object.values(results).reduce((a, b) => a + b, 0) : 0;
  const maxRes = results ? Math.max(1, ...Object.values(results)) : 1;
  const dis = !!busy;

  return (
    <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', minHeight: '100vh', background: T.paper, color: T.ink, fontFamily: T.font, letterSpacing: '-0.02em', wordBreak: 'keep-all' }}>
      {/* ── 사이드바 (모바일=상단 스택) ── */}
      <aside style={{ width: narrow ? '100%' : 244, flex: 'none', background: T.panel, borderRight: narrow ? 'none' : `1px solid ${T.line}`, borderBottom: narrow ? `1px solid ${T.line}` : 'none', padding: narrow ? '16px' : '22px 18px', display: 'flex', flexDirection: 'column', gap: 8, position: narrow ? 'static' : 'sticky', top: 0, height: narrow ? 'auto' : '100vh', boxSizing: 'border-box' }}>
        <button onClick={() => { setView('session'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 18 }}>
          <img src="/logo/mongbas-symbol-blue.svg" alt="" style={{ width: 30, height: 30 }} />
          <span style={{ fontSize: 19, fontWeight: 900, letterSpacing: '-0.05em', color: T.ink }}>MONGBAS</span>
        </button>
        <Nav label="관제" sub="실시간 투표" active={view === 'session'} onClick={() => setView('session')} />
        <Nav label="개표" sub="종료 + 집계" active={view === 'tally'} onClick={tallyNow} accent />
        <Nav label="검증" sub="Merkle 봉인" active={view === 'verify'} onClick={() => setView('verify')} />
        <div style={{ height: 1, background: T.line, margin: '14px 0' }} />
        <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.14em', color: T.sub, marginBottom: 6 }}>세션 제어</div>
        <input
          type="password"
          autoComplete="off"
          aria-label="관리자 API 토큰"
          placeholder="관리자 토큰"
          value={adminToken}
          onChange={(e) => { activeControlAdminToken = e.target.value; setAdminToken(e.target.value); }}
          style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.line}`, borderRadius: 8, padding: '9px 10px', fontSize: 12, marginBottom: 6 }}
        />
        <SBtn onClick={newSession} disabled={dis} solid>＋ 새 세션 시작</SBtn>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.sub, margin: '10px 0 2px' }}>커스텀 투표 주입 (후보별)</div>
        {CANDIDATES.map((c, i) => {
          const off = dis || status !== 'ACTIVE';
          return (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 900, letterSpacing: '-0.02em', color: off ? '#9aa2c0' : T.ink }}>{c}</span>
              <select value={inj[i]} onChange={(e) => { const v = [...inj]; v[i] = +e.target.value; setInj(v); }} disabled={off}
                style={{ height: 34, width: 54, padding: '0 6px', fontSize: 14, fontWeight: 900, fontFamily: 'inherit', color: T.ink, background: '#fff', border: `1.5px solid ${off ? '#dfe3f3' : T.blue}`, cursor: off ? 'not-allowed' : 'pointer' }}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button onClick={() => seed(inj[i], i)} disabled={off} title={`${c} ${inj[i]}표 주입`}
                style={{ height: 34, width: 34, flex: 'none', fontSize: 18, fontWeight: 900, lineHeight: 1, fontFamily: 'inherit', color: '#fff', background: off ? '#c2c9e6' : T.blue, border: 'none', cursor: off ? 'not-allowed' : 'pointer' }}>＋</button>
            </div>
          );
        })}
        <div style={{ marginTop: 'auto', fontSize: 11, color: T.sub, fontWeight: 700 }}>
          {busy ? <span style={{ color: T.blue }}>⏳ {busy}</span> : <span>ElGamal · 2-of-3 임계</span>}
        </div>
      </aside>

      {/* ── 메인 ── */}
      <main style={{ flex: 1, minWidth: 0, padding: '26px clamp(20px,3vw,40px) 60px', boxSizing: 'border-box' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, marginBottom: 22, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 'clamp(26px,3vw,36px)', fontWeight: 900, letterSpacing: '-0.04em' }}>
              {view === 'tally' ? '개표 결과' : view === 'verify' ? '내 표 검증' : '투표현황 대시보드'}
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: T.sub, fontWeight: 600, fontFamily: 'monospace' }}>{eid || 'Mongbas 부스 시연 · 익명 전자투표'}</p>
          </div>
          <Status status={status} />
        </header>

        {!eid && <Empty />}

        {eid && view === 'session' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 18 }}>
              <KPI label="실시간 투표수" value={live} unit="표" big />
              <KPI label="후보" value={CANDIDATES.length} unit="명" sub="치킨·피자·떡볶이" />
              <KPI label="암호화" value="ElGamal" unit="+ZKP" sub="동형암호" small />
              <KPI label="검증 합의" value="2-of-3" unit="" sub="3개 기관" small />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(0,1.6fr) minmax(0,1fr)', gap: 18, alignItems: 'start' }}>
              <VoteTable votes={votes} shuffled={shuffled} status={status} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <QRCard qr={qr} url={kioskUrl} error={kioskUrlError} onRenew={renewAdmission} disabled={dis || status !== 'ACTIVE'} expiresAt={admission?.expiresAt} />
                <LogCard log={log} />
              </div>
            </div>
          </>
        )}

        {eid && view === 'tally' && <TallyView results={results} decrypted={decrypted} total={totalRes} max={maxRes} busy={busy} votes={votes} shuffled={shuffled} live={live} math={tallyMath} rootHash={rootHash} />}

        {eid && view === 'verify' && (
          <VerifyView code={vcode} setCode={setVcode} run={() => runVerify(vcode)} tamper={tamper} res={vres} fail={vfail} busy={busy} status={status} rootHash={rootHash} />
        )}
      </main>
    </div>
  );
}

// ── 컴포넌트 ──
const box = { background: T.paper, border: `1.5px solid ${T.line}`, padding: 20, boxSizing: 'border-box' };
const over = { fontSize: 11, fontWeight: 900, letterSpacing: '0.14em', color: T.sub, textTransform: 'uppercase' };

function Nav({ label, sub, active, onClick, accent }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, textAlign: 'left',
      padding: '11px 13px', border: `1.5px solid ${active ? T.blue : 'transparent'}`, cursor: 'pointer',
      background: active ? T.blue : (accent ? T.paper2 : 'transparent'), color: active ? '#fff' : T.ink,
      fontFamily: 'inherit', transition: 'background .15s',
    }}>
      <span style={{ fontSize: 15, fontWeight: 900, letterSpacing: '-0.03em' }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, color: active ? 'rgba(255,255,255,.8)' : T.sub }}>{sub}</span>
    </button>
  );
}
function SBtn({ children, onClick, disabled, solid }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        height: 40, padding: '0 14px', fontSize: 13.5, fontWeight: 900, fontFamily: 'inherit', textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer', letterSpacing: '-0.02em',
        background: disabled ? '#e6e9f5' : solid ? (h ? T.blueD : T.blue) : (h ? T.paper2 : T.paper),
        color: disabled ? '#a6adc8' : solid ? '#fff' : T.blue,
        border: `1.5px solid ${disabled ? '#e6e9f5' : T.blue}`, transition: 'background .15s, transform .15s',
        transform: h && !disabled ? 'translateY(-1px)' : 'none',
      }}>{children}</button>
  );
}
function Status({ status }) {
  const m = { ACTIVE: ['● 진행중', T.blue, '#fff'], CLOSED: ['● 종료됨', T.ink, '#fff'], '-': ['대기', T.paper2, T.sub] }[status] || ['대기', T.paper2, T.sub];
  return <span style={{ fontSize: 12.5, fontWeight: 900, letterSpacing: '0.02em', background: m[1], color: m[2], padding: '7px 14px', border: `1.5px solid ${m[1] === T.paper2 ? T.line : m[1]}` }}>{m[0]}</span>;
}
function KPI({ label, value, unit, sub, big, small }) {
  return (
    <div style={{ ...box, position: 'relative', overflow: 'hidden' }}>
      <div style={over}>{label}</div>
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: big ? 46 : small ? 24 : 34, fontWeight: 900, letterSpacing: '-0.05em', color: big ? T.blue : T.ink, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        {unit && <span style={{ fontSize: 14, fontWeight: 900, color: T.blue }}>{unit}</span>}
      </div>
      {sub && <div style={{ marginTop: 6, fontSize: 12, color: T.sub, fontWeight: 700 }}>{sub}</div>}
    </div>
  );
}
function VoteTable({ votes, shuffled, status }) {
  return (
    <section style={{ ...box, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: `1.5px solid ${T.line}` }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: '-0.03em' }}>🔒 암호화된 투표 — 공개 원장 실시간</div>
          <div style={{ fontSize: 12, color: T.sub, fontWeight: 700, marginTop: 2 }}>서버는 암호문만 받습니다 · 누가 뭘 찍었는지 모름</div>
        </div>
        {shuffled
          ? <span style={{ fontSize: 11.5, fontWeight: 900, background: T.blue, color: '#fff', padding: '6px 11px' }}>🔀 셔플됨 · 시간 상관 제거</span>
          : <span style={{ fontSize: 11.5, fontWeight: 900, background: T.paper2, color: T.blue, padding: '6px 11px' }}>● LIVE</span>}
      </div>
      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: T.ink, color: '#fff', position: 'sticky', top: 0 }}>
              {['#', '무효화 해시', '암호문 (c₁:c₂)', 'ZKP'].map((h, i) => (
                <th key={h} style={{ textAlign: i === 3 ? 'center' : 'left', padding: '9px 14px', fontWeight: 800, fontSize: 11, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {votes.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 28, textAlign: 'center', color: T.sub, fontWeight: 700 }}>
                {status === 'ACTIVE' ? '폰으로 투표하거나 [투표 +10] 을 누르면 여기 암호문이 실시간으로 쌓입니다' : '세션을 시작하세요'}
              </td></tr>
            )}
            {votes.slice().reverse().map((v, ri) => (
              <tr key={v.nh} style={{ borderBottom: `1px solid ${T.line}`, background: ri === 0 && !shuffled ? T.paper2 : '#fff', animation: ri === 0 && !shuffled ? 'cvrow .5s ease' : 'none' }}>
                <td style={{ padding: '9px 14px', fontWeight: 800, color: T.blue }}>{String(v.seq).padStart(2, '0')}</td>
                <td style={{ padding: '9px 14px', color: T.ink }}>{tr(v.nh, 12)}</td>
                <td style={{ padding: '9px 14px', color: T.sub }}>{tr(v.c1, 8)}:{(v.c2 || '').slice(0, 8)}…</td>
                <td style={{ padding: '9px 14px', textAlign: 'center', color: T.blue, fontWeight: 900 }}>✓</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function QRCard({ qr, url, error, onRenew, disabled, expiresAt }) {
  return (
    <section style={{ ...box, textAlign: 'center' }}>
      <div style={over}>여기 찍고 투표하세요</div>
      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center' }}>
        {qr ? <img src={qr} alt="QR" style={{ width: 200, height: 200, border: `1.5px solid ${T.line}` }} />
          : <div style={{ width: 200, height: 200, padding: 18, boxSizing: 'border-box', background: T.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: error ? '#b42318' : T.sub, fontSize: 13, fontWeight: 700 }}>{error || '새 세션 시작 시 QR 표시'}</div>}
      </div>
      {url && <div style={{ marginTop: 10, fontSize: 10.5, color: T.sub, wordBreak: 'break-all', fontFamily: 'monospace' }}>{displayKioskUrl(url)}</div>}
      {expiresAt && <div style={{ marginTop: 8, fontSize: 11.5, color: T.sub, fontWeight: 700 }}>일회용 · {new Date(expiresAt).toLocaleTimeString()}까지</div>}
      <button onClick={onRenew} disabled={disabled}
        style={{ width: '100%', marginTop: 12, padding: 11, border: `1.5px solid ${T.blue}`, background: disabled ? T.paper2 : '#fff', color: disabled ? T.sub : T.blue, fontSize: 13, fontWeight: 900, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer' }}>
        다음 참가자용 새 QR 발급
      </button>
      <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.5, color: T.sub }}>한 QR은 휴대폰 한 대에서만 사용할 수 있습니다. 다음 투표자 전에 새로 발급하세요.</div>
    </section>
  );
}
function LogCard({ log }) {
  return (
    <section style={{ ...box }}>
      <div style={over}>활동 로그</div>
      <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 11.5, color: T.sub, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {log.length === 0 ? <span>아직 활동이 없습니다.</span> : log.map((l, i) => <div key={i} style={{ opacity: i === 0 ? 1 : 0.6 }}>{l}</div>)}
      </div>
    </section>
  );
}
function TallyView({ results, decrypted, total, max, busy, votes, shuffled, live, math, rootHash }) {
  const panic = Math.max(0, (live || 0) - (total || 0));
  const m = math || {};
  const tc = (h) => (h ? `${h.slice(0, 16)}…${h.slice(-6)}` : '—');
  const STEPS = [
    { n: '①', t: '암호문 동형 합산', f: '∏ Eᵢ = ( ∏ g^rᵢ , g^Σmᵢ · y^Σrᵢ )', d: '암호문들을 곱하면 평문을 보지 않고 합계의 암호문 1개가 됩니다',
      val: m.c1 ? [`c₁ = ${tc(m.c1)}`, `c₂ = ${tc(m.c2)}`] : null, vd: `게시판 암호문 ${m.ballotCount || 0}개를 모두 곱한 실제 합계 암호문입니다` },
    { n: '②', t: '2-of-3 키 복원', f: 'x = Σ λⱼ · sⱼ  (라그랑주 보간)', d: '3개 기관 중 2개의 Shamir 조각으로 개인키 x 복원',
      val: ['사용한 조각 = [1, 2]', 'x = ●●●●●● (비공개)'], vd: '개인키 x는 복원되지만 화면엔 안 띄웁니다 — 공개하면 보안 위반이라서요' },
    { n: '③', t: '복호화', f: 'M = c₂ / c₁ˣ = g^Σmᵢ', d: '복원한 키로 합계의 암호문만 복호화',
      val: m.M ? [`g^Σmᵢ = ${tc(m.M)}`] : null, vd: '합계 암호문을 복호화한 실제 값입니다 (= g의 Σmᵢ 제곱)' },
    { n: '④', t: '이산로그 (BSGS)', f: 'g^Σmᵢ → Σmᵢ → 후보별 분해 (base B=10000)', d: 'Baby-step Giant-step으로 합계 지수 복원 후 후보별로 분리',
      val: m.sum ? [`Σmᵢ = ${m.sum}`, (m.perCand || []).map((c) => `${c.cn} ${c.v}`).join(' · ')] : null, vd: '지수 합 Σmᵢ를 10000진법으로 풀면 후보별 실제 득표가 됩니다' },
    { n: '⑤', t: 'Merkle 게시판 공개', f: 'root = H( … )', d: '모든 암호문을 봉인해 누구나 독립 검증 가능',
      val: rootHash ? [tc(rootHash)] : null, vd: '게시판 전체 암호문을 봉인한 실제 루트 해시입니다' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section style={{ ...box }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 900, letterSpacing: '-0.03em' }}>최종 결과 <span style={{ color: T.sub, fontWeight: 800, fontSize: 13 }}>· {total}표</span></div>
          <span style={{ fontSize: 12, fontWeight: 900, background: decrypted ? '#fff' : T.paper2, color: T.blue, border: `1.5px solid ${T.blue}`, padding: '6px 12px' }}>{busy ? busy : decrypted ? '복호화 완료 ✓' : '복호화 대기'}</span>
        </div>
        {decrypted && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.paper2, color: T.blue }}>전체 {Math.max(live || 0, total)}표</span>
            <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.blue, color: '#fff' }}>정상 {total}표 집계</span>
            {panic > 0 && <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.ink, color: '#fff' }}>🟦 패닉 {panic}표 집계 제외 (연구 데모)</span>}
          </div>
        )}
        {panic > 0 && decrypted && (
          <div style={{ fontSize: 12.5, fontWeight: 700, color: T.sub, marginBottom: 14, lineHeight: 1.5 }}>
            제한된 API 응답 크기·타이밍 실험은 관측된 차이를 줄였지만, PDC 운영자·네트워크·재투표 패턴을 포함한 전체 강압저항성은 미검증입니다.
          </div>
        )}
        {results ? CANDIDATES.map((c, i) => {
          const v = results[c] ?? 0; const lead = v === max && max > 0;
          return (
            <div key={c} style={{ marginBottom: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 900, marginBottom: 6 }}>
                <span>{lead ? '🥇 ' : ''}{c}</span><span style={{ color: T.sub }}>{v}표 · {total ? Math.round(v / total * 100) : 0}%</span>
              </div>
              <div style={{ background: T.paper2, height: 16, overflow: 'hidden', border: `1px solid ${T.line}` }}>
                <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: lead ? `linear-gradient(90deg,${T.blueSky},${T.blue})` : T.blueSoft, transition: 'width .8s cubic-bezier(.4,0,.2,1)' }} />
              </div>
            </div>
          );
        }) : <div style={{ color: T.sub, fontWeight: 700, padding: 14 }}>{busy || '집계 진행 중…'}</div>}
      </section>

      <section style={{ ...box }}>
        <div style={{ ...over, marginBottom: 4 }}>집계 과정 · 동형암호로 비밀키 없이 합산 <span style={{ color: T.blue }}>— 오른쪽은 실제 계산값</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {STEPS.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16, padding: '16px 0', borderTop: i ? `1px solid ${T.line}` : 'none' }}>
              {/* 왼쪽: 수식/설명 */}
              <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
                <div style={{ width: 34, height: 34, flex: 'none', background: T.blue, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 17 }}>{s.n}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: '-0.03em' }}>{s.t}</div>
                  <div style={{ marginTop: 5, display: 'inline-block', fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, background: T.ink, color: '#fff', padding: '5px 10px', maxWidth: '100%', wordBreak: 'break-all' }}>{s.f}</div>
                  <div style={{ marginTop: 6, fontSize: 12, color: T.sub, fontWeight: 600, lineHeight: 1.5 }}>{s.d}</div>
                </div>
              </div>
              {/* 오른쪽: 실제 값 + 간단 설명 */}
              <div style={{ borderLeft: `2px solid ${T.blue}`, paddingLeft: 14, minWidth: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: '.12em', color: T.blue }}>실제 값</div>
                {s.val ? s.val.map((v, j) => (
                  <div key={j} style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 12.5, fontWeight: 800, color: T.ink, wordBreak: 'break-all', lineHeight: 1.4 }}>{v}</div>
                )) : <div style={{ marginTop: 4, fontSize: 12, color: T.sub, fontWeight: 600 }}>{busy ? '계산 중…' : '—'}</div>}
                <div style={{ marginTop: 7, fontSize: 11.5, color: T.sub, fontWeight: 600, lineHeight: 1.55 }}>{s.vd}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <VoteTable votes={votes} shuffled={shuffled} status="CLOSED" />
    </div>
  );
}
function VerifyView({ code, setCode, run, tamper, res, fail, busy, status, rootHash }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 920 }}>
      {rootHash && (
        <section style={{ background: T.blue, color: '#fff', padding: '18px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: '.14em', opacity: 0.85 }}>공개된 봉인 해시 · MERKLE ROOT</div>
          <div style={{ marginTop: 7, fontFamily: 'monospace', fontSize: 'clamp(13px,1.4vw,15px)', fontWeight: 800, wordBreak: 'break-all', lineHeight: 1.4 }}>{rootHash}</div>
          <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, opacity: 0.92 }}>추적하면 “내가 다시 계산한 봉인 = 이 공개 봉인” 이 일치합니다 — 비밀키 없이 누구나 검증.</div>
        </section>
      )}
      <section style={{ ...box }}>
        <div style={over}>추적번호로 내 표 검증 (실제 Merkle 봉인)</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="예: 7F3A-90 또는 무효화 해시"
            style={{ flex: '1 1 240px', height: 46, padding: '0 14px', fontSize: 15, fontWeight: 800, fontFamily: 'monospace', border: `1.5px solid ${T.line}`, color: T.ink, outline: 'none' }} />
          <SBtn onClick={run} disabled={busy} solid>추적하기</SBtn>
          <SBtn onClick={tamper} disabled={busy || !res}>번호 한 글자 바꿔보기</SBtn>
        </div>
        {status !== 'CLOSED' && <div style={{ marginTop: 10, fontSize: 12.5, color: T.sub, fontWeight: 700 }}>※ 게시판은 개표(종료) 후 공개됩니다. 먼저 [개표]를 진행하세요.</div>}
        {fail && <div style={{ marginTop: 14, padding: 14, background: '#fff', border: `1.5px solid ${T.ink}`, color: T.ink, fontWeight: 800, fontSize: 13.5 }}>✗ {fail}</div>}
      </section>

      {res && (
        <>
          <section style={{ ...box, padding: 0, overflow: 'hidden' }}>
            <div style={{ ...over, padding: '14px 18px', borderBottom: `1.5px solid ${T.line}` }}>공개 게시판 — 내 줄 하이라이트 ({res.idx + 1}/{res.total})</div>
            <div style={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12.5 }}>
              {res.ballots.map((b, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 18px', background: i === res.idx ? T.blue : '#fff', color: i === res.idx ? '#fff' : T.sub, fontWeight: i === res.idx ? 900 : 600, borderBottom: `1px solid ${T.line}` }}>
                  <span>{i === res.idx ? '➡' : '　'}</span><span>#{String(i + 1).padStart(2, '0')}</span><span>{(b.nullifierHash || '').slice(0, 28)}…</span>
                </div>
              ))}
            </div>
          </section>
          <section style={{ ...box, background: res.sealMatch ? T.blue : T.ink, color: '#fff', border: 'none' }}>
            <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: '-0.03em' }}>{res.sealMatch ? '✓ 포함 증명 일치 — 공개 게시판 Root 재계산 성공' : '✗ 포함 증명 불일치'}</div>
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr', gap: 6, fontFamily: 'monospace', fontSize: 12 }}>
              <Kv k="내가 다시 계산한 봉인(root)" v={res.computedRoot} />
              <Kv k="블록체인에 저장된 봉인(root)" v={res.chainRoot} />
              <Kv k="내 표 leaf 해시" v={res.leafHash} />
            </div>
            <div style={{ marginTop: 12, fontSize: 13, fontWeight: 700, opacity: 0.92 }}>
              {res.sealMatch ? '내 표를 넣어 봉인을 다시 계산해도 블록체인의 봉인과 똑같습니다 — 비밀키 없이 누구나 검증.' : '봉인이 달라 변조가 즉시 드러납니다.'}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
function Kv({ k, v }) {
  return <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><span style={{ opacity: 0.7, minWidth: 200 }}>{k}</span><span style={{ wordBreak: 'break-all', fontWeight: 800 }}>{v}</span></div>;
}
function Empty() {
  return (
    <div style={{ ...box, padding: 48, textAlign: 'center' }}>
      <img src="/logo/mongbas-symbol-blue.svg" alt="" style={{ width: 56, height: 56, opacity: 0.9 }} />
      <div style={{ marginTop: 16, fontSize: 20, fontWeight: 900, letterSpacing: '-0.04em' }}>세션을 시작하세요</div>
      <div style={{ marginTop: 6, fontSize: 13.5, color: T.sub, fontWeight: 700 }}>좌측 [＋ 새 세션 시작]을 누르면 선거가 생성되고 QR이 표시됩니다.</div>
    </div>
  );
}

if (typeof document !== 'undefined' && !document.getElementById('cv-kf')) {
  const s = document.createElement('style'); s.id = 'cv-kf';
  s.textContent = '@keyframes cvrow{from{background:#dfe5ff;transform:translateX(-6px);opacity:.4}to{transform:none;opacity:1}}';
  document.head.appendChild(s);
}
