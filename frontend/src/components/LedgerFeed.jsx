import { useEffect, useState } from 'react';

/**
 * 관제판 실시간 원장 피드 (흰 바탕 · 파란 테두리).
 * 표가 Fabric에 커밋될 때마다 블록 카드가 위에 쌓인다. 값은 모두 실제 커밋 결과:
 * 블록 번호 · 트랜잭션 ID(전체) · 암호문(c₁, 공개 원장 값).
 * 누가 냈는지 이을 수 있는 값(무효화 해시, 재투표 연결)은 서버가 아예 보내지 않는다.
 *
 * 참고한 패턴: mempool.space의 입체 블록 표현, Etherscan/Blockscout의
 * 고정폭 해시 + 복사 버튼 + 상태 배지 + 원본 펼쳐보기.
 */
const T = {
  blue: '#2440F2', blueD: '#1A2BC9', sky: '#5B8CFF', ink: '#0a0f24', sub: '#5b6683', faint: '#8a93ad',
  line: '#dfe4fb', lineBlue: '#c9d3ff', paper: '#ffffff', tint: '#f5f7ff', tint2: '#eef1ff', ok: '#0f9d58',
};
const mono = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

function ago(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 전` : new Date(ts).toLocaleTimeString();
}
const groups = (hex, size = 4) => (hex.match(new RegExp(`.{1,${size}}`, 'g')) || []).join(' ');

function BlockGlyph({ fresh }) {
  // 작은 등각 블록 (mempool.space 스타일의 입체 블록을 단순화)
  const top = fresh ? '#7a9bff' : '#9fb3ff', left = fresh ? '#2440F2' : '#3a55f0', right = fresh ? '#1A2BC9' : '#2a40d0';
  return (
    <svg width="30" height="32" viewBox="0 0 30 32" aria-hidden="true" style={{ flex: 'none', filter: fresh ? 'drop-shadow(0 4px 10px rgba(36,64,242,.35))' : 'none' }}>
      <polygon points="15,2 28,9 15,16 2,9" fill={top} />
      <polygon points="2,9 15,16 15,30 2,23" fill={left} />
      <polygon points="28,9 15,16 15,30 28,23" fill={right} />
    </svg>
  );
}

function CopyButton({ value, label }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" title={`${label} 복사`} onClick={() => {
      navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {});
    }} style={{ flex: 'none', height: 24, padding: '0 8px', border: `1px solid ${T.lineBlue}`, background: done ? T.blue : T.paper, color: done ? '#fff' : T.blue, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, lineHeight: 1, cursor: 'pointer', borderRadius: 6, transition: 'all .15s' }}>
      {done ? '복사됨' : '복사'}
    </button>
  );
}

function Field({ k, children, action }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '68px 1fr auto', gap: 10, alignItems: 'start', padding: '7px 0', borderTop: `1px dashed ${T.line}` }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: T.sub, paddingTop: 2 }}>{k}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
      {action || <span />}
    </div>
  );
}

function BlockCard({ e, now, fresh, isLast }) {
  const [open, setOpen] = useState(false);
  const cipherShown = e.cipher ? (open ? e.cipher : e.cipher.slice(0, 96)) : '';
  return (
    <div style={{ position: 'relative', display: 'flex', gap: 14, paddingBottom: isLast ? 0 : 16 }}>
      <div style={{ position: 'relative', width: 30, flex: 'none', display: 'flex', justifyContent: 'center' }}>
        <BlockGlyph fresh={fresh} />
        {!isLast && <span style={{ position: 'absolute', top: 34, bottom: -16, left: 14, width: 2, background: `repeating-linear-gradient(${T.lineBlue} 0 5px, transparent 5px 9px)` }} />}
      </div>
      <article style={{
        flex: 1, minWidth: 0, background: T.paper, border: `1.5px solid ${fresh ? T.blue : T.lineBlue}`, borderRadius: 12,
        padding: '13px 16px 10px', boxShadow: fresh ? '0 10px 30px rgba(36,64,242,.16)' : '0 1px 2px rgba(16,24,64,.05)',
        animation: fresh ? 'lfdrop .55s cubic-bezier(.2,.9,.25,1.12)' : 'none', transition: 'border-color .4s, box-shadow .4s',
      }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', color: T.ink }}>
            {e.block ? <>블록 <span style={{ fontFamily: mono, color: T.blue }}>#{e.block}</span></> : <>기록 #{String(e.seq).padStart(2, '0')}</>}
          </span>
          {(e.tx || e.cipher) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: T.ok, background: '#e9f8ef', border: '1px solid #bfe8cf', padding: '3px 8px', borderRadius: 999 }}>
            <span style={{ width: 6, height: 6, borderRadius: 9, background: T.ok }} />기록 완료</span>}
          <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: fresh ? T.blue : T.faint, fontVariantNumeric: 'tabular-nums' }}>{e.recovered ? '원장에서 복구' : ago(e.ts, now)}</span>
        </header>
        {e.tx || e.cipher ? (
          <>
            {e.tx && <Field k="트랜잭션" action={<CopyButton value={e.tx} label="트랜잭션 ID" />}>
              <span style={{ fontFamily: mono, fontSize: 12.5, color: T.ink, wordBreak: 'break-all', lineHeight: 1.55 }}>{groups(e.tx, 8)}</span>
            </Field>}
            {e.cipher && <Field k="암호문 c₁" action={<CopyButton value={e.cipher} label="암호문" />}>
              <span style={{ fontFamily: mono, fontSize: 12, color: '#3b4ec9', wordBreak: 'break-all', lineHeight: 1.6 }}>{groups(cipherShown, 4)}{!open && e.cipher.length > 96 ? ' …' : ''}</span>
              {e.cipher.length > 96 && (
                <button type="button" onClick={() => setOpen(!open)} style={{ display: 'block', marginTop: 4, padding: 0, border: 0, background: 'none', color: T.blue, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700, lineHeight: 1.4, cursor: 'pointer' }}>
                  {open ? '접기' : `전체 보기 (${e.cipher.length}자)`}
                </button>
              )}
            </Field>}
            <Field k="확인">
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['3개 기관 중 2곳 이상 서명', '영지식증명 통과', '지울 수 없는 기록'].map((t) => (
                  <span key={t} style={{ fontSize: 11.5, fontWeight: 700, color: T.blue, background: T.tint2, border: `1px solid ${T.lineBlue}`, padding: '3px 9px', borderRadius: 999 }}>{t}</span>
                ))}
              </span>
            </Field>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: T.sub, fontWeight: 600 }}>{e.recovered ? '서버 재시작 뒤 원장 상태에서 개수만 복구 · 블록 정보 없음' : '커밋 확인'}</div>
        )}
      </article>
    </div>
  );
}

export default function LedgerFeed({ events, status }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const list = events.slice().reverse();
  const latestBlock = list.find((e) => e.block)?.block;
  const live = status === 'ACTIVE';

  return (
    <section style={{ background: T.paper, border: `1.5px solid ${T.blue}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 2px rgba(16,24,64,.04), 0 12px 32px rgba(36,64,242,.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: `1px solid ${T.line}`, background: 'linear-gradient(180deg,#ffffff,#f8f9ff)' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.035em', color: T.ink }}>블록체인 원장</div>
          <div style={{ marginTop: 3, fontSize: 12.5, fontWeight: 500, color: T.sub, lineHeight: 1.5 }}>
            표가 3개 기관 원장에 기록될 때마다 블록이 하나씩 쌓임 · 누가 냈는지는 남지 않음
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
          {latestBlock && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: T.faint, letterSpacing: '.06em' }}>최신 블록</div>
              <div style={{ fontFamily: mono, fontSize: 15, fontWeight: 700, color: T.blue }}>#{latestBlock}</div>
            </div>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: live ? T.ok : T.faint, background: live ? '#e9f8ef' : T.tint, border: `1px solid ${live ? '#bfe8cf' : T.line}`, padding: '5px 10px', borderRadius: 999 }}>
            <span style={{ width: 7, height: 7, borderRadius: 9, background: live ? T.ok : '#b3bad0', animation: live ? 'lfpulse 1.6s ease-in-out infinite' : 'none' }} />
            {live ? '실시간' : '기록 종료'}
          </span>
        </div>
      </div>

      <div style={{ maxHeight: 600, overflowY: 'auto', padding: list.length ? '18px 20px' : 0, background: T.paper }}>
        {list.length === 0 && (
          <div style={{ padding: '52px 20px', textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', opacity: 0.35 }}><BlockGlyph /></div>
            <div style={{ marginTop: 10, color: T.sub, fontSize: 13.5, fontWeight: 600 }}>
              {live ? '휴대폰으로 투표하면 여기에 블록이 쌓임' : '세션을 시작하면 원장 기록이 여기에 표시됨'}
            </div>
          </div>
        )}
        {list.map((e, i) => (
          <BlockCard key={e.seq} e={e} now={now} fresh={i === 0 && now - e.ts < 4000} isLast={i === list.length - 1} />
        ))}
      </div>
      <div style={{ padding: '11px 20px', background: T.tint, borderTop: `1px solid ${T.line}`, color: T.sub, fontSize: 11.5, fontWeight: 500, lineHeight: 1.55 }}>
        다시 투표해도 기존 블록은 지워지지 않고 새 블록이 하나 더 쌓임. 어떤 블록이 같은 사람 것인지는 화면·서버 어디에도 표시되지 않음.
      </div>
    </section>
  );
}

if (typeof document !== 'undefined' && !document.getElementById('lf-style')) {
  const s = document.createElement('style');
  s.id = 'lf-style';
  s.textContent = '@keyframes lfdrop{0%{opacity:0;transform:translateY(-16px) scale(.98)}100%{opacity:1;transform:none}}@keyframes lfpulse{0%,100%{opacity:1}50%{opacity:.35}}';
  document.head.appendChild(s);
}
