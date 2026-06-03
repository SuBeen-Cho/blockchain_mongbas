import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';

/**
 * ControlPage — 부스 시연용 발표자 관제판 (Phase 3)
 * 진입: /?app=control
 *
 * 한 화면에서: 새 세션(생성+활성+QR) / 투표 자동주입 / 라이브 카운터 /
 *              집계 종료(→2-of-3 조각 복원→복호화) / 결과
 */
const API = '/api';
const CANDIDATES = ['Alice', 'Bob', 'Charlie'];
const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#f59e0b'];

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
  const [results, setResults] = useState(null);   // {Alice:n,...} (복호화 후)
  const [decrypted, setDecrypted] = useState(false);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);
  const pollRef = useRef(null);

  const kioskUrl = eid ? `${window.location.origin}/?app=kiosk&e=${encodeURIComponent(eid)}` : '';

  const addLog = useCallback((m) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 8)), []);

  // QR 생성
  useEffect(() => {
    if (kioskUrl) QRCode.toDataURL(kioskUrl, { width: 240, margin: 1 }).then(setQr).catch(() => setQr(''));
    else setQr('');
  }, [kioskUrl]);

  // 라이브 카운터 폴링 (ACTIVE일 때)
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
    setBusy('새 세션 생성 중...');
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
    setBusy(`${n}표 자동 주입 중...`);
    try {
      const r = await J(`/elections/${encodeURIComponent(eid)}/seed-votes`, { method: 'POST', body: JSON.stringify({ count: n }) });
      addLog(`자동 주입: ${r.injected}표 ${JSON.stringify(r.breakdown)}`);
      const c = await J(`/elections/${encodeURIComponent(eid)}/live-count`); setLive(c.totalVotes);
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  async function closeAndTally() {
    if (!eid) return;
    if (!window.confirm('집계를 종료합니다. 되돌릴 수 없습니다. 진행할까요?')) return;
    setBusy('종료 + 키 분산 중...');
    try {
      await J(`/elections/${encodeURIComponent(eid)}/close`, { method: 'POST' });
      setStatus('CLOSED'); addLog('선거 종료 — 결과는 2개 기관 조각 복원 후 복호화');
      setBusy('기관 조각 복원 중 (2-of-3)...');
      for (const idx of ['1', '2']) {
        const s = await J(`/elections/${encodeURIComponent(eid)}/shares/${idx}`);
        await J(`/elections/${encodeURIComponent(eid)}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: idx, shareHex: s.shareHex }) });
        addLog(`조각 ${idx}/2 제출`);
      }
      setBusy('결과 복호화 확인 중...');
      let t = null;
      for (let i = 0; i < 10; i++) {
        t = await J(`/elections/${encodeURIComponent(eid)}/tally`);
        if (t.decrypted) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      setResults(t.results); setDecrypted(!!t.decrypted);
      addLog(t.decrypted ? `복호화 완료: ${JSON.stringify(t.results)}` : '복호화 대기 중');
      // 검증(내 표 추적)용 데이터 준비: Merkle 트리 + 게시판 공개
      setBusy('검증 데이터 준비 중...');
      try {
        await J(`/elections/${encodeURIComponent(eid)}/merkle`, { method: 'POST' });
        await J(`/elections/${encodeURIComponent(eid)}/publish-audit`, { method: 'POST' });
        addLog('Merkle 트리 + 게시판 공개 완료 (내 표 추적 검증 준비됨)');
      } catch (e) { addLog('검증 데이터 준비 경고: ' + e.message); }
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  const maxVotes = results ? Math.max(1, ...Object.values(results)) : 1;

  return (
    <div style={{ boxSizing: 'border-box', width: '100%', minHeight: '100vh', overflowX: 'hidden', background: '#0f172a', color: '#e2e8f0', fontFamily: 'system-ui,-apple-system,sans-serif', padding: 20 }}>
      <div style={{ boxSizing: 'border-box', width: '100%', maxWidth: 920, margin: '0 auto' }}>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>🎛️ 발표자 관제판</h1>
        <div style={{ color: '#64748b', fontSize: 13, marginBottom: 20 }}>Mongbas 부스 시연 · ElGamal threshold</div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          {/* 좌: 상태 + 컨트롤 */}
          <div style={{ flex: '1 1 340px', minWidth: 0 }}>
            <div style={{ background: '#1e293b', borderRadius: 12, padding: 18, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, color: '#94a3b8' }}>현재 세션</div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{eid || '(없음)'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ padding: '4px 10px', borderRadius: 999, fontSize: 12, background: status === 'ACTIVE' ? '#166534' : status === 'CLOSED' ? '#7f1d1d' : '#334155' }}>● {status}</span>
                  <div style={{ fontSize: 34, fontWeight: 800, marginTop: 8 }}>{live}<span style={{ fontSize: 14, color: '#94a3b8' }}> 표</span></div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
              <Btn onClick={newSession} disabled={!!busy} bg="#2563eb">새 세션 시작</Btn>
              <Btn onClick={() => seed(5)} disabled={!eid || status !== 'ACTIVE' || !!busy} bg="#0891b2">투표 +5</Btn>
              <Btn onClick={() => seed(10)} disabled={!eid || status !== 'ACTIVE' || !!busy} bg="#0891b2">투표 +10</Btn>
              <Btn onClick={closeAndTally} disabled={!eid || status !== 'ACTIVE' || !!busy} bg="#dc2626">집계 종료 &amp; 결과</Btn>
              <Btn onClick={() => window.open(`/?app=track&e=${encodeURIComponent(eid)}`, '_blank')} disabled={!eid || status !== 'CLOSED'} bg="#7c3aed">내 표 검증 열기</Btn>
            </div>

            {busy && <div style={{ color: '#fbbf24', fontSize: 14, marginBottom: 12 }}>⏳ {busy}</div>}

            {/* 결과 */}
            {results && (
              <div style={{ background: '#1e293b', borderRadius: 12, padding: 18, marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>
                  결과 {decrypted ? '(복호화 완료)' : '(복호화 대기 — 2-of-3 조각 필요)'}
                </div>
                {CANDIDATES.map((c, i) => (
                  <div key={c} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{c}</span><span>{results[c] ?? 0}</span></div>
                    <div style={{ background: '#334155', borderRadius: 6, height: 16, overflow: 'hidden' }}>
                      <div style={{ width: `${((results[c] ?? 0) / maxVotes) * 100}%`, height: '100%', background: COLORS[i % COLORS.length], transition: 'width .5s' }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 로그 */}
            <div style={{ background: '#0b1220', borderRadius: 12, padding: 14, fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>
              {log.length === 0 ? '로그 없음' : log.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>

          {/* 우: QR */}
          <div style={{ flex: '1 1 240px', boxSizing: 'border-box', background: '#1e293b', borderRadius: 12, padding: 18, textAlign: 'center', height: 'fit-content' }}>
            <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10 }}>여기 찍고 투표하세요</div>
            {qr ? <img src={qr} alt="kiosk QR" style={{ width: 220, borderRadius: 8 }} /> : <div style={{ color: '#475569', padding: 40 }}>세션을 시작하면<br />QR이 표시됩니다</div>}
            {kioskUrl && <div style={{ fontSize: 10, color: '#475569', marginTop: 10, wordBreak: 'break-all' }}>{kioskUrl}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Btn({ children, onClick, disabled, bg }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding: '12px 18px', borderRadius: 10, border: 'none', fontSize: 15, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', color: '#fff', background: disabled ? '#334155' : bg, opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}
