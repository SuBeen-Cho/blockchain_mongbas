import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';

/**
 * ControlPage — 발표자 관제판 (P7 라이트 대시보드 리디자인 · UI 가이드라인 적용)
 * 진입: /?app=control
 */
const API = '/api';
const CANDIDATES = ['치킨', '피자', '떡볶이'];
const BAR = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#d97706'];

// ── 디자인 토큰 (가이드라인 60-30-10 / 8px 그리드) ──
const T = {
  font: '"Pretendard Variable",Pretendard,-apple-system,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif',
  bg: '#f8fafc', card: '#ffffff', border: '#e2e8f0', ink: '#0f172a', sub: '#64748b', faint: '#94a3b8',
  primary: '#2563eb', primaryDark: '#1d4ed8', success: '#16a34a', successBg: '#f0fdf4',
  danger: '#dc2626', dangerBg: '#fef2f2', violet: '#7c3aed',
  shadow: '0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04)',
};

async function J(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json', ...(headers || {}) }, ...rest });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) throw new Error(j.error || `${path} ${r.status}`);
  return j;
}

export default function ControlPage() {
  const [eid, setEid] = useState(null);
  const [status, setStatus] = useState('-');
  const [live, setLive] = useState(0);
  const [results, setResults] = useState(null);
  const [decrypted, setDecrypted] = useState(false);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);
  const pollRef = useRef(null);
  const kioskUrl = eid ? `${window.location.origin}/?app=kiosk&e=${encodeURIComponent(eid)}` : '';
  const addLog = useCallback((m) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 8)), []);

  useEffect(() => {
    if (kioskUrl) QRCode.toDataURL(kioskUrl, { width: 280, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } }).then(setQr).catch(() => setQr(''));
    else setQr('');
  }, [kioskUrl]);

  useEffect(() => {
    clearInterval(pollRef.current);
    if (eid && status === 'ACTIVE') {
      pollRef.current = setInterval(async () => {
        try { const c = await J(`/elections/${encodeURIComponent(eid)}/live-count`); setLive(c.totalVotes); } catch { /* noop */ }
      }, 2000);
    }
    return () => clearInterval(pollRef.current);
  }, [eid, status]);

  async function newSession() {
    setBusy('새 세션 생성 중…');
    try {
      const id = `DEMO_${Date.now()}`;
      const now = Math.floor(Date.now() / 1000);
      await J('/elections', { method: 'POST', body: JSON.stringify({ electionID: id, title: '2026 모의 선거', candidates: CANDIDATES, encryptionMode: 'elgamal', endTime: now + 24 * 3600 }) });
      await J(`/elections/${id}/activate`, { method: 'POST' });
      setEid(id); setStatus('ACTIVE'); setLive(0); setResults(null); setDecrypted(false);
      addLog(`새 세션 시작: ${id}`);
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  async function seed(n) {
    if (!eid) return;
    setBusy(`투표 ${n}건 자동 주입 중…`);
    try {
      const r = await J(`/elections/${encodeURIComponent(eid)}/seed-votes`, { method: 'POST', body: JSON.stringify({ count: n }) });
      addLog(`자동 주입: ${r.injected}표`);
      const c = await J(`/elections/${encodeURIComponent(eid)}/live-count`); setLive(c.totalVotes);
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  async function closeAndTally() {
    if (!eid) return;
    if (!window.confirm('집계를 종료합니다. 되돌릴 수 없습니다. 진행할까요?')) return;
    setBusy('종료 + 키 분산 중…');
    try {
      await J(`/elections/${encodeURIComponent(eid)}/close`, { method: 'POST' });
      setStatus('CLOSED'); addLog('선거 종료 — 결과는 2개 기관 조각 복원 후 복호화');
      setBusy('기관 조각 복원 중 (2-of-3)…');
      for (const idx of ['1', '2']) {
        const s = await J(`/elections/${encodeURIComponent(eid)}/shares/${idx}`);
        await J(`/elections/${encodeURIComponent(eid)}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: idx, shareHex: s.shareHex }) });
        addLog(`조각 ${idx}/2 제출`);
      }
      setBusy('결과 복호화 확인 중…');
      let t = null;
      for (let i = 0; i < 10; i++) {
        t = await J(`/elections/${encodeURIComponent(eid)}/tally`);
        if (t.decrypted) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      setResults(t.results); setDecrypted(!!t.decrypted);
      addLog(t.decrypted ? `복호화 완료` : '복호화 대기 중');
      setBusy('검증 데이터 준비 중…');
      try {
        await J(`/elections/${encodeURIComponent(eid)}/merkle`, { method: 'POST' });
        await J(`/elections/${encodeURIComponent(eid)}/publish-audit`, { method: 'POST' });
        addLog('Merkle 트리 + 게시판 공개 완료 (내 표 추적 검증 준비됨)');
      } catch (e) { addLog('검증 데이터 준비 경고: ' + e.message); }
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  const maxVotes = results ? Math.max(1, ...Object.values(results)) : 1;
  const totalRes = results ? Object.values(results).reduce((a, b) => a + b, 0) : 0;
  const disabled = !!busy;

  return (
    <div style={{ boxSizing: 'border-box', width: '100%', minHeight: '100vh', overflowX: 'hidden', background: T.bg, color: T.ink, fontFamily: T.font, letterSpacing: '-0.01em', wordBreak: 'keep-all' }}>
      <div style={{ boxSizing: 'border-box', maxWidth: 1120, margin: '0 auto', padding: '32px 24px 64px' }}>
        {/* 헤더 */}
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <Logo />
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>발표자 관제판</h1>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: T.sub, fontWeight: 500 }}>Mongbas 부스 시연 · ElGamal 2-of-3 threshold</p>
          </div>
        </header>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          {/* 좌측: 메인 */}
          <div style={{ flex: '1 1 540px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* 상태 카드 */}
            <section style={{ ...card(), position: 'relative', overflow: 'hidden', background: 'linear-gradient(135deg,#ffffff 60%,#f3f2ff)' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'linear-gradient(90deg,#2563eb,#7c3aed,#06b6d4)' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div>
                  <div style={overline()}>현재 세션</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>{eid || '—'}</div>
                  <StatusBadge status={status} />
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={overline()}>실시간 투표 수</div>
                  <div style={{ fontSize: 56, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em', background: 'linear-gradient(135deg,#2563eb,#7c3aed)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{live}</div>
                  <div style={{ fontSize: 12, color: T.faint, fontWeight: 600 }}>표</div>
                </div>
              </div>
            </section>

            {/* 컨트롤 카드 */}
            <section style={card()}>
              <div style={overline()}>세션 제어</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
                <Btn onClick={newSession} disabled={disabled} variant="primary">＋ 새 세션 시작</Btn>
                <Btn onClick={() => seed(5)} disabled={disabled || status !== 'ACTIVE'} variant="ghost">투표 +5</Btn>
                <Btn onClick={() => seed(10)} disabled={disabled || status !== 'ACTIVE'} variant="ghost">투표 +10</Btn>
                <Btn onClick={closeAndTally} disabled={disabled || status !== 'ACTIVE'} variant="danger">집계 종료 &amp; 결과</Btn>
                <Btn onClick={() => window.open(`/?app=track&e=${encodeURIComponent(eid)}`, '_blank')} disabled={status !== 'CLOSED'} variant="violet">내 표 검증 열기 ↗</Btn>
              </div>
              {busy && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 14, color: T.primaryDark, fontWeight: 600 }}>
                  <Spinner /> {busy}
                </div>
              )}
            </section>

            {/* 결과 카드 */}
            {results && (
              <section style={card()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={overline()}>개표 결과</div>
                  <span style={pill(decrypted ? T.success : T.danger, decrypted ? T.successBg : T.dangerBg)}>
                    {decrypted ? '복호화 완료' : '복호화 대기 (2-of-3 필요)'}
                  </span>
                </div>
                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {CANDIDATES.map((c, i) => {
                    const v = results[c] ?? 0;
                    return (
                      <div key={c}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                          <span>{c}</span><span style={{ color: T.sub }}>{v}표 · {totalRes ? Math.round(v / totalRes * 100) : 0}%</span>
                        </div>
                        <div style={{ background: '#eef2f6', borderRadius: 8, height: 12, overflow: 'hidden' }}>
                          <div style={{ width: `${(v / maxVotes) * 100}%`, height: '100%', background: BAR[i % BAR.length], borderRadius: 8, transition: 'width .6s cubic-bezier(.4,0,.2,1)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* 로그 */}
            <section style={{ ...card(), padding: 16 }}>
              <div style={overline()}>활동 로그</div>
              <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 12, color: T.sub, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {log.length === 0 ? <span style={{ color: T.faint }}>아직 활동이 없습니다.</span> : log.map((l, i) => <div key={i} style={{ opacity: i === 0 ? 1 : 0.65 }}>{l}</div>)}
              </div>
            </section>
          </div>

          {/* 우측: QR */}
          <aside style={{ flex: '1 1 280px', boxSizing: 'border-box', ...card(), textAlign: 'center', position: 'sticky', top: 24 }}>
            <div style={overline()}>여기 찍고 투표하세요</div>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
              {qr ? (
                <img src={qr} alt="kiosk QR" style={{ width: 240, height: 240, borderRadius: 12, border: `1px solid ${T.border}` }} />
              ) : (
                <div style={{ width: 240, height: 240, borderRadius: 12, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.faint, fontSize: 14, fontWeight: 500, padding: 20 }}>
                  새 세션을 시작하면<br />QR이 표시됩니다
                </div>
              )}
            </div>
            {kioskUrl && <div style={{ marginTop: 12, fontSize: 11, color: T.faint, wordBreak: 'break-all', fontFamily: 'monospace' }}>{kioskUrl}</div>}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ── 컴포넌트 ──
function card() {
  return { boxSizing: 'border-box', background: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: 24, boxShadow: T.shadow };
}
function overline() {
  return { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: T.faint, textTransform: 'uppercase' };
}
function pill(color, bg) {
  return { fontSize: 12, fontWeight: 700, color, background: bg, padding: '5px 12px', borderRadius: 999 };
}
function StatusBadge({ status }) {
  const map = {
    ACTIVE: { t: '진행중', c: T.success, bg: T.successBg },
    CLOSED: { t: '종료됨', c: T.danger, bg: T.dangerBg },
    '-': { t: '대기', c: T.sub, bg: '#f1f5f9' },
  };
  const m = map[status] || map['-'];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, ...pill(m.c, m.bg) }}>
    <span style={{ width: 7, height: 7, borderRadius: 999, background: m.c }} /> {m.t}
  </span>;
}
function Btn({ children, onClick, disabled, variant }) {
  const styles = {
    primary: { bg: T.primary, color: '#fff', border: 'transparent', hover: T.primaryDark },
    danger: { bg: T.danger, color: '#fff', border: 'transparent', hover: '#b91c1c' },
    violet: { bg: T.violet, color: '#fff', border: 'transparent', hover: '#6d28d9' },
    ghost: { bg: '#fff', color: T.ink, border: T.border, hover: '#f8fafc' },
  }[variant] || {};
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        boxSizing: 'border-box', height: 44, padding: '0 18px', borderRadius: 10, fontSize: 14, fontWeight: 600,
        fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled ? '#e2e8f0' : (h ? styles.hover : styles.bg),
        color: disabled ? '#94a3b8' : styles.color,
        border: `1px solid ${disabled ? '#e2e8f0' : styles.border}`,
        transition: 'background .18s ease, transform .18s ease, box-shadow .18s ease',
        transform: h && !disabled ? 'translateY(-1px)' : 'none',
        boxShadow: h && !disabled && variant !== 'ghost' ? '0 4px 12px rgba(37,99,235,.22)' : 'none',
      }}>
      {children}
    </button>
  );
}
function Spinner() {
  return <span style={{ width: 16, height: 16, border: '2px solid #c7d2fe', borderTopColor: T.primary, borderRadius: 999, display: 'inline-block', animation: 'cspin .7s linear infinite' }} />;
}
function Logo() {
  return (
    <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#2563eb,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div>
  );
}

// 스피너 keyframes 주입 (한 번)
if (typeof document !== 'undefined' && !document.getElementById('cspin-kf')) {
  const s = document.createElement('style'); s.id = 'cspin-kf';
  s.textContent = '@keyframes cspin{to{transform:rotate(360deg)}}';
  document.head.appendChild(s);
}
