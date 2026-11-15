import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import QRCode from 'qrcode';
import { buildSecureKioskUrl, displayKioskUrl } from '../utils/kioskUrl.js';
import { fetchMongbasJSON, verifyMerkleNullifier } from '../utils/merkleVerification.js';
import { findUniqueReceiptMatch, normalizeReceiptPrefix } from '../utils/receiptLookup.js';
import { sha256 } from '../utils/crypto.js';
import { verifyVectorBallotProofBrowser } from '../utils/ballotProof.js';
import { verifyCountedSlot, zeroSlot, PANIC_POLICY_DENIABLE_SLOT } from '../utils/countedSlot.js';
import { buildTallyStory, shortHex } from '../utils/tallyStory.js';
// three.js는 개표 화면에서만 받음 (휴대폰 투표 화면 번들에서 제외)
const TallyAnimation = lazy(() => import('../components/TallyAnimation.jsx'));

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
function kioskURL(electionID, admissionToken = '', serverVoterOrigin = '') {
  const configured = String(serverVoterOrigin || import.meta.env.VITE_PUBLIC_VOTER_ORIGIN || '').trim();
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

export default function ControlPage() {
  const [adminToken, setAdminToken] = useState('');
  const [eid, setEid] = useState(() => new URLSearchParams(window.location.search).get('e'));
  const [status, setStatus] = useState('-');
  const [view, setView] = useState('session');     // session | tally | verify
  const [live, setLive] = useState(0);
  const [votes, setVotes] = useState([]);          // 라이브 암호문 표
  const [castEvents, setCastEvents] = useState([]); // 식별자를 숨긴 누적 커밋 확인 피드
  const [paddingCount, setPaddingCount] = useState(0);
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
  const [story, setStory] = useState(null);         // 공개 게시판에서 다시 계산한 개표 과정 값
  const loadStory = useCallback(async (electionID, tallyResults) => {
    try {
      const board = await J(`/elections/${encodeURIComponent(electionID)}/bulletin-board`);
      setStory(buildTallyStory(board, CANDIDATES, tallyResults));
    } catch { setStory(null); }
  }, []);
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 860);
  const pollRef = useRef(null); const evRef = useRef(0);
  const pendingVerifyRef = useRef('');
  // 관리자 전용 입구(127.0.0.1)로 열린 관제판인지 서버에 확인 → 토큰 입력 생략
  const [localAdmin, setLocalAdmin] = useState(false);
  const [voterOrigin, setVoterOrigin] = useState('');
  useEffect(() => {
    fetch('/health').then((r) => r.json()).then((h) => {
      setLocalAdmin(h.localAdmin === true);
      setVoterOrigin(h.publicVoterOrigin || '');
    }).catch(() => {});
  }, []);
  let kioskUrl = ''; let kioskUrlError = '';
  if (eid && admission?.token) {
    if (localAdmin && !voterOrigin) kioskUrlError = '휴대폰용 공개 주소가 아직 없음 · 터널 실행 뒤 PUBLIC_VOTER_ORIGIN 설정';
    else {
      try { kioskUrl = kioskURL(eid, admission.token, voterOrigin); } catch (error) { kioskUrlError = error.message; }
    }
  }
  useEffect(() => { const f = () => setNarrow(window.innerWidth < 860); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  const addLog = useCallback((m) => setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 10)), []);

  // 새로고침 또는 공유된 관제 URL로 진입해도 기존 원장 세션을 복구한다.
  useEffect(() => {
    if (!eid || status !== '-') return;
    J(`/elections/${encodeURIComponent(eid)}`)
      .then(async (election) => {
        setStatus(election.status || '-');
        if (election.status === 'CLOSED') {
          const closedTally = await J(`/elections/${encodeURIComponent(eid)}/tally`);
          setResults(closedTally.results); setDecrypted(!!closedTally.decrypted);
          try { const mk = await J(`/elections/${encodeURIComponent(eid)}/merkle`); setRootHash(mk.rootHash || ''); } catch { /* 아직 미구축 */ }
          if (closedTally.decrypted) loadStory(eid, closedTally.results);
          setView('tally');
        }
      })
      .catch((error) => addLog('세션 복구 오류: ' + error.message));
  }, [eid, status, addLog, loadStory]);

  useEffect(() => {
    let cancelled = false;
    if (kioskUrl) {
      QRCode.toDataURL(kioskUrl, { width: 320, margin: 1, color: { dark: '#0a0f24', light: '#ffffff' } })
        .then((value) => { if (!cancelled) setQr(value); })
        .catch(() => { if (!cancelled) setQr(''); });
    } else setQr('');
    return () => { cancelled = true; };
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
        let nextVotes = lv.votes || [];
        let nextEvents = lv.castEvents || [];
        if (nextVotes.length === 0 && nextEvents.length === 0) {
          try {
            const snapshot = await J(`/elections/${encodeURIComponent(eid)}/dashboard-snapshot`);
            nextVotes = (snapshot.ballots || []).map((ballot, index) => ({
              seq: index + 1, nh: ballot.nullifierHash,
              c1: ballot.encryptedCandidateVector?.[0]?.c1 || ballot.encryptedCandidateID || '[encrypted]',
              c2: ballot.encryptedCandidateVector?.[0]?.c2 || '', zkp: !!ballot.vectorBallotValidityProof,
              recovered: true,
            }));
            nextEvents = Array.from({ length: snapshot.castEventCount || 0 }, (_, index) => ({ seq: index + 1, recovered: true }));
            setLive(snapshot.activeBallots || 0);
            setPaddingCount(snapshot.paddingCount || 0);
          } catch { /* pre-upgrade runtime or oversized elections keep the in-memory view */ }
        }
        setVotes(nextVotes); setCastEvents(nextEvents); setShuffled(!!lv.shuffled);
        const ev = await J(`/elections/${encodeURIComponent(eid)}/demo-events?since=${evRef.current}`);
        if (ev.events && ev.events.length) {
          evRef.current = ev.lastSeq;
          for (const e of ev.events) {
            if (e.type === 'verify') {
              const code = e.payload?.code || e.payload?.nullifier || '';
              pendingVerifyRef.current = code; setVcode(code); setView('verify');
              setVres(null);
              setVfail(status === 'CLOSED'
                ? '휴대폰의 검증 요청을 받았습니다. 아래 [추적하기]를 눌러 직접 검증하세요.'
                : '휴대폰의 검증 요청을 받았습니다. 개표를 종료한 뒤 [추적하기]를 눌러 직접 검증하세요.');
            }
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
    const id = `DEMO_${Date.now()}`;
    setEid(id); setStatus('CREATING'); setLive(0); setVotes([]); setCastEvents([]); setPaddingCount(0); setShuffled(false);
    const nextUrl = new URL(window.location.href); nextUrl.searchParams.set('e', id); window.history.replaceState(null, '', nextUrl);
    setAdmission(null); setResults(null); setDecrypted(false); setView('session');
    setVres(null); setVfail(''); setRootHash(''); setStory(null); evRef.current = 0;
    addLog(`새 세션 생성 요청: ${id}`);
    try {
      const now = Math.floor(Date.now() / 1000);
      await J('/elections', { method: 'POST', body: JSON.stringify({ electionID: id, title: '2026 모의 선거', candidates: CANDIDATES, encryptionMode: 'elgamal-vector-v3', endTime: now + 24 * 3600, panicPolicy: PANIC_POLICY_DENIABLE_SLOT }) });
      setStatus('CREATED'); setBusy('선거 활성화 중…'); addLog('선거 생성 커밋 확인');
      await J(`/elections/${id}/activate`, { method: 'POST' });
      setStatus('ACTIVE'); setBusy('세션 공용 QR 발급 중…'); addLog('선거 활성화 확인');
      const issuedAdmission = await J('/credential/demo-admission', { method: 'POST', body: JSON.stringify({ electionID: id, ttlSeconds: 900 }) });
      setAdmission(issuedAdmission);
      addLog(`새 세션 시작: ${id}`);
    } catch (e) { addLog('오류: ' + e.message); setBusy(''); return; }
    setBusy('');
  }

  async function renewAdmission() {
    if (!eid || status !== 'ACTIVE') return;
    setBusy('새 세션 공용 QR 발급 중…');
    try {
      const issued = await J('/credential/demo-admission', { method: 'POST', body: JSON.stringify({ electionID: eid, ttlSeconds: 900 }) });
      setAdmission(issued);
      addLog('새 세션 공용 QR 발급');
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
    if (status === 'CLOSED') {
      setView('tally'); setBusy('집계 결과 불러오는 중…');
      try {
        const closedTally = await J(`/elections/${encodeURIComponent(eid)}/tally`);
        setResults(closedTally.results); setDecrypted(!!closedTally.decrypted);
        try { const mk = await J(`/elections/${encodeURIComponent(eid)}/merkle`); setRootHash(mk.rootHash || ''); } catch { /* 아직 미구축 */ }
        if (closedTally.decrypted) await loadStory(eid, closedTally.results);
      } catch (e) { addLog('집계 결과 조회 오류: ' + e.message); }
      setBusy(''); return;
    }
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
      // 0표(패닉표만 존재하는 경우 포함)는 CloseElection이 즉시 decrypted
      // 결과를 확정한다. 이때 존재하지 않는 대기 암호문에 partial share를
      // 반복 제출하면 화면이 영원히 집계 중처럼 보이므로 먼저 tally를 읽는다.
      let t = await J(`/elections/${encodeURIComponent(eid)}/tally`);
      if (!t.decrypted) {
        setBusy('2-of-3 partial decryption 중…');
        for (const idx of ['1', '2']) {
          let submitted = false;
          for (let attempt = 0; attempt < 30 && !submitted; attempt++) {
            try {
              await J(`/elections/${encodeURIComponent(eid)}/partial-decryptions`, { method: 'POST', body: JSON.stringify({ shareIndex: idx }) });
              submitted = true;
            } catch (error) {
              // 직전 요청의 커밋 결과가 응답보다 먼저 확정된 경우를 복구한다.
              const reconciled = await J(`/elections/${encodeURIComponent(eid)}/tally`).catch(() => null);
              if (reconciled?.decrypted) { t = reconciled; submitted = true; break; }
              if (attempt === 29) throw error;
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
          addLog(`기관 ${idx}/2 증명된 partial decryption 제출`);
          if (t.decrypted) break;
        }
      } else {
        addLog('유효표 0건 — 추가 partial decryption 없이 0표 집계 확정');
      }
      setBusy('복호화 확인 중…');
      for (let i = 0; i < 12 && !t.decrypted; i++) { t = await J(`/elections/${encodeURIComponent(eid)}/tally`); if (t.decrypted) break; await new Promise((r) => setTimeout(r, 800)); }
      setResults(t.results); setDecrypted(!!t.decrypted);
      addLog(t.decrypted ? '복호화 완료' : '복호화 대기');
      setBusy('Merkle 게시판 공개 중…');
      try {
        await J(`/elections/${encodeURIComponent(eid)}/merkle`, { method: 'POST' });
        const mk = await J(`/elections/${encodeURIComponent(eid)}/merkle`); setRootHash(mk.rootHash || '');
        addLog('Merkle 봉인 생성 완료 · 포함 증명 검증 준비됨');
        // 감사 게시판 공개는 별도 원장 트랜잭션이다. 이 단계가 실패해도 이미
        // 커밋된 Merkle root/proof 검증까지 막지 않는다.
        let bulletinPublished = false;
        try {
          await J(`/elections/${encodeURIComponent(eid)}/publish-audit`, { method: 'POST' });
          bulletinPublished = true;
          addLog('감사 게시판 공개 완료 (표시 순서 셔플)');
        } catch (publishError) {
          addLog(`감사 게시판 공개 경고: ${publishError.message} · Merkle 검증은 계속 가능`);
        }
        // 개표 과정 연출·단계 값은 공개 게시판에서 다시 계산한 실제 값만 사용
        if (bulletinPublished) await loadStory(eid, t.results);
        if (pendingVerifyRef.current) {
          setVfail('Merkle 봉인이 준비됐습니다. 검증 화면에서 [추적하기]를 눌러 직접 검증하세요.');
        }
      } catch (e) { addLog('게시판 경고: ' + e.message); }
    } catch (e) { addLog('오류: ' + e.message); }
    setBusy('');
  }

  // 실제 검증: 추적번호 → 게시판 → 표 규칙 증명 → 집계 칸 이력 → 봉인 재계산 → 공개 봉인 비교
  async function runVerify(rawCode, tampered = false) {
    if (!eid) return;
    if (status !== 'CLOSED') {
      setVfail('아직 개표 전이라 게시판이 없음. [개표]로 선거를 종료한 뒤 추적 진행');
      return;
    }
    setBusy('검증 진행 중…'); setVres(null); setVfail('');
    const steps = [];
    const push = (step) => { steps.push(step); return step; };
    const skipRest = (from) => { for (const title of from) push({ title, status: 'skip', lines: ['앞 단계에서 멈춰서 진행 안 함'] }); };
    const REST = ['규칙대로 만든 표인지 확인', '집계 칸 기록 다시 따라가기', '봉인 다시 계산', '공개 봉인과 비교'];
    let board = null, ballot = null, index = -1, full = '';
    try {
      board = await fetchMongbasJSON(`/api/elections/${encodeURIComponent(eid)}/bulletin-board`);
      const ballots = board.encryptedBallots || [];
      const prefix = normalizeReceiptPrefix(rawCode);
      if (/^[0-9a-f]{64}$/.test(prefix)) index = ballots.findIndex((b) => String(b.nullifierHash).toLowerCase() === prefix);
      else index = findUniqueReceiptMatch(ballots, prefix).index;
      ballot = ballots[index];
      if (!ballot) throw new Error('not found');
      full = ballot.nullifierHash;
      push({ title: '게시판에서 내 표 찾기', status: 'ok', lines: [
        `공개 게시판 표 ${ballots.length}개 중 ${index + 1}번째 줄에서 확인`,
        `추적번호 ${String(rawCode).slice(0, 12)} → 기록 번호 ${shortHex(full, 12, 6)}`,
      ] });
    } catch {
      push({ title: '게시판에서 내 표 찾기', status: 'fail', lines: tampered
        ? ['한 글자 바뀐 번호라 게시판 어디에도 없음', '검증 여기서 중단 · 변조 탐지 확인']
        : ['이 번호의 표를 게시판에서 찾지 못함', '번호를 다시 확인한 뒤 추적 진행'] });
      skipRest(REST);
      setVres({ steps, ok: false, tampered }); setBusy(''); return;
    }

    const pub = board.elgamalPubKey;
    const candidates = CANDIDATES;
    const proof = await verifyVectorBallotProofBrowser(pub, ballot.encryptedCandidateVector, ballot.vectorBallotValidityProof);
    push({ title: '규칙대로 만든 표인지 확인', status: proof.ok ? 'ok' : 'fail', lines: [
      ...candidates.map((c, k) => `${c} 칸: 0 또는 1만 들어 있음 ${proof.bits[k] ? '확인' : '실패'}`),
      `전체에서 선택이 정확히 1개 ${proof.sum ? '확인' : '실패'}`,
      '어느 후보를 골랐는지는 끝까지 열지 않음',
    ] });

    const deniable = board.panicPolicy === PANIC_POLICY_DENIABLE_SLOT;
    if (deniable) {
      const chain = ballot.countedSlotChain || [];
      let previous = zeroSlot(candidates.length), chainOk = chain.length > 0;
      const lines = [];
      for (const [i, step] of chain.entries()) {
        const ok = await verifyCountedSlot({ pubKey: pub, electionID: eid, nullifierHash: full,
          visible: step.encryptedCandidateVector, previous, next: step.countedVector, proof: step.countedSlotProof });
        lines.push(`${i + 1}번째 투표 기록: 집계 칸이 규칙대로 바뀌었는지 ${ok ? '확인' : '실패'}`);
        chainOk = chainOk && ok;
        previous = step.countedVector;
      }
      const lastMatches = JSON.stringify(previous) === JSON.stringify(ballot.countedVector);
      chainOk = chainOk && lastMatches;
      lines.push(`마지막 집계 칸 = 개표에 들어간 칸 ${lastMatches ? '확인' : '실패'}`);
      lines.push('각 기록이 새 표인지 패닉 표인지는 증명 안에 숨겨져 있음');
      push({ title: '집계 칸 기록 다시 따라가기', status: chainOk ? 'ok' : 'fail', lines });
    } else {
      push({ title: '집계 칸 기록 다시 따라가기', status: 'skip', lines: ['이 선거는 마지막 표를 그대로 집계하는 방식이라 해당 없음'] });
    }

    try {
      const merkle = await verifyMerkleNullifier({ electionID: eid, nullifierHash: full });
      const lines = [`내 표 봉인값 ${shortHex(merkle.leafHash, 12, 6)}`];
      let current = merkle.leafHash;
      if (!merkle.proof.length) {
        current = await sha256(current);
        lines.push(`표가 1개뿐이라 봉인값을 한 번 더 감싸서 ${shortHex(current, 12, 6)}`);
      }
      for (const [i, node] of merkle.proof.entries()) {
        current = node.position === 'left' ? await sha256(node.hash + current) : await sha256(current + node.hash);
        lines.push(`${i + 1}단계: ${node.position === 'left' ? '왼쪽' : '오른쪽'} 이웃 ${shortHex(node.hash, 8, 4)}과 합쳐 ${shortHex(current, 12, 6)}`);
      }
      lines.push(`비밀키 없이 공개된 값만으로 ${merkle.proof.length}단계 계산 진행`);
      push({ title: '봉인 다시 계산', status: 'ok', lines });
      push({ title: '공개 봉인과 비교', status: merkle.sealMatch ? 'ok' : 'fail', lines: [
        `내가 계산한 봉인   ${merkle.computedRoot}`,
        `블록체인 공개 봉인 ${merkle.chainRoot}`,
        merkle.sealMatch ? '두 값이 글자 하나까지 같음 · 내 표가 빠지거나 바뀌지 않았음 확인' : '두 값이 다름 · 변조 의심',
      ] });
      addLog(`검증: ${tr(full, 8)} → ${merkle.sealMatch ? '봉인 일치 ✓' : '불일치 ✗'}`);
    } catch (e) {
      push({ title: '봉인 다시 계산', status: 'fail', lines: [e.message] });
      push({ title: '공개 봉인과 비교', status: 'skip', lines: ['앞 단계에서 멈춰서 진행 안 함'] });
    }
    setVres({ steps, ok: steps.every((st) => st.status !== 'fail'), tampered, index, total: (board.encryptedBallots || []).length, ballots: board.encryptedBallots || [] });
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
        {localAdmin ? (
          <div style={{ fontSize: 11.5, fontWeight: 800, color: T.blue, background: T.paper2, padding: '9px 10px', marginBottom: 6, lineHeight: 1.45 }}>관리자 전용 화면 · 이 컴퓨터에서만 열림</div>
        ) : <input
          type="password"
          autoComplete="off"
          aria-label="관리자 API 토큰"
          placeholder="관리자 토큰"
          value={adminToken}
          onChange={(e) => { activeControlAdminToken = e.target.value; setAdminToken(e.target.value); }}
          style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${T.line}`, borderRadius: 8, padding: '9px 10px', fontSize: 12, marginBottom: 6 }}
        />}
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
            <p style={{ margin: '4px 0 0', fontSize: 13, color: T.sub, fontWeight: 600, fontFamily: 'monospace' }}>{eid || 'Mongbas 부스 시연 · 암호화·검증 투표'}</p>
          </div>
          <Status status={status} />
        </header>

        {!eid && <Empty />}

        {eid && view === 'session' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 18 }}>
              <KPI label="현재 active ballot" value={live} unit="표" big />
              <KPI label="누적 커밋 확인" value={castEvents.length} unit="건" sub="최초 투표와 재투표 모두" />
              <KPI label="후보" value={CANDIDATES.length} unit="명" sub="치킨·피자·떡볶이" />
              <KPI label="암호화" value="ElGamal" unit="+ZKP" sub="동형암호" small />
              <KPI label="검증 합의" value="2-of-3" unit="" sub="3개 기관" small />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(0,1.6fr) minmax(0,1fr)', gap: 18, alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <VoteTable votes={votes} shuffled={shuffled} status={status} />
                <CastEventLog events={castEvents} status={status} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <QRCard qr={qr} url={kioskUrl} error={kioskUrlError} onRenew={renewAdmission} disabled={dis || status !== 'ACTIVE'} expiresAt={admission?.expiresAt} />
                <LogCard log={log} />
              </div>
            </div>
          </>
        )}

        {eid && view === 'tally' && <TallyView results={results} decrypted={decrypted} total={totalRes} max={maxRes} busy={busy} votes={votes} shuffled={shuffled} live={live} story={story} rootHash={rootHash} />}

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
          <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: '-0.03em' }}>🔒 현재 유효 암호문</div>
          <div style={{ fontSize: 12, color: T.sub, fontWeight: 700, marginTop: 2 }}>재투표 시 최신 표로 교체 · 집계에는 유권자별 마지막 표만 반영</div>
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
                {status === 'ACTIVE' ? '폰으로 투표하거나 커스텀 표를 주입하면 현재 유효 암호문이 표시됩니다' : '세션을 시작하세요'}
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
function CastEventLog({ events, status }) {
  return (
    <section style={{ ...box, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1.5px solid ${T.line}` }}>
        <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: '-0.03em' }}>⛓ 누적 원장 커밋 확인</div>
        <div style={{ fontSize: 12, color: T.sub, fontWeight: 700, marginTop: 2 }}>
          최초 투표와 재투표를 모두 누적 · 재투표 연결정보와 무효화 해시는 숨김
        </div>
      </div>
      <div style={{ maxHeight: 210, overflowY: 'auto' }}>
        {events.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: T.sub, fontSize: 12, fontWeight: 700 }}>
            {status === 'ACTIVE' ? '원장 커밋이 확인되면 여기에 순서대로 표시됩니다' : '누적 기록이 없습니다'}
          </div>
        ) : events.slice().reverse().map((event) => (
          <div key={event.seq} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 14px', borderBottom: `1px solid ${T.line}`, fontSize: 12 }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 900, color: T.blue }}>CAST #{String(event.seq).padStart(2, '0')}</span>
            <span style={{ color: T.sub, fontWeight: 700 }}>{event.recovered ? '원장 상태에서 합계 복구 · 순서 미복구' : `${new Date(event.ts).toLocaleTimeString()} · COMMITTED`}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '9px 14px', background: T.paper2, color: T.sub, fontSize: 10.5, fontWeight: 700, lineHeight: 1.45 }}>
        이 목록은 Fabric 커밋 성공 뒤 갱신되는 시연용 피드입니다. 권위 있는 불변 이력은 cast-event export와 bundle 검증으로 확인합니다.
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
      {expiresAt && <div style={{ marginTop: 8, fontSize: 11.5, color: T.sub, fontWeight: 700 }}>세션 공용 QR · {new Date(expiresAt).toLocaleTimeString()}까지</div>}
      <button onClick={onRenew} disabled={disabled}
        style={{ width: '100%', marginTop: 12, padding: 11, border: `1.5px solid ${T.blue}`, background: disabled ? T.paper2 : '#fff', color: disabled ? T.sub : T.blue, fontSize: 13, fontWeight: 900, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer' }}>
        다음 참가자용 새 QR 발급
      </button>
      <div style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.5, color: T.sub }}>이 QR은 현재 세션의 여러 휴대폰에서 사용할 수 있습니다. 만료되면 QR을 갱신하세요.</div>
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
function TallyView({ results, decrypted, total, max, busy, votes, shuffled, live, story, rootHash }) {
  const deniable = !!story?.deniable;
  const panic = deniable ? 0 : Math.max(0, (live || 0) - (total || 0));
  const orgName = (msp) => ({ ElectionCommissionMSP: '선거관리위원회', PartyObserverMSP: '참관 정당', CivilSocietyMSP: '시민단체' }[msp] || msp);
  const STEPS = story ? [
    { t: deniable ? '집계 칸 모으기' : '게시된 암호문 모으기',
      f: deniable ? '유권자마다 증명이 붙은 집계 칸 1개' : '유권자마다 마지막 암호문 1개',
      d: deniable ? '공개된 표가 아니라 집계 칸을 사용 · 패닉 투표는 집계 칸을 바꾸지 못함' : '재투표하면 마지막 표만 남음',
      val: [`유권자 ${story.voters}명 · 누적 투표 기록 ${story.totalCasts}건`] },
    { t: '후보별 암호문 합산', f: 'Cₖ = ∏ 집계칸ₖ   (암호문끼리 곱하기 = 속 내용 더하기)',
      d: '표를 하나도 열지 않고 후보별 합계의 암호문만 만듦',
      val: story.candidates.map((c, k) => `${c}  ${shortHex(story.aggregate[k]?.c1, 14, 6)}`),
      note: story.aggregateMatches ? '게시판의 합산값과 직접 다시 계산한 값 일치 확인' : '게시판 합산값과 다름 · 확인 필요' },
    { t: '2-of-3 부분 복호화', f: 'dⱼ = c₁^sⱼ   (기관 j의 열쇠 조각 sⱼ)',
      d: '3개 기관 중 2곳이 각자 계산 · 열쇠 원본은 어디에도 모이지 않음',
      val: story.partials.map((pd) => `${orgName(pd.mspID)}  ${shortHex(pd.values[0], 12, 4)}  · 증명 ${pd.proofs}개`) },
    { t: '부분값 합쳐서 득표 수 찾기', f: 'g^득표 = c₂ / ∏ dⱼ^λⱼ  →  득표 수',
      d: '합계만 나오고 개별 표의 선택은 끝까지 열리지 않음',
      val: story.candidates.map((c, k) => `${c}  ${story.counts[k]}표`) },
    { t: '게시판 봉인', f: 'root = H( 모든 표 … )', d: '누구나 내 표가 들어갔는지 따로 확인 가능',
      val: rootHash ? [shortHex(rootHash, 18, 8)] : ['봉인 생성 전'] },
  ] : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section style={{ ...box }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 17, fontWeight: 900, letterSpacing: '-0.03em' }}>최종 결과 <span style={{ color: T.sub, fontWeight: 800, fontSize: 13 }}>· {total}표</span></div>
          <span style={{ fontSize: 12, fontWeight: 900, background: decrypted ? '#fff' : T.paper2, color: T.blue, border: `1.5px solid ${T.blue}`, padding: '6px 12px' }}>{busy ? busy : decrypted ? '복호화 완료' : '복호화 대기'}</span>
        </div>
        {decrypted && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {deniable ? (
              <>
                <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.paper2, color: T.blue }}>투표한 사람 {story.voters}명</span>
                <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.blue, color: '#fff' }}>집계 반영 {total}표</span>
                <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.ink, color: '#fff' }}>패닉 보호 켜짐</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.paper2, color: T.blue }}>현재 active ballot {Math.max(live || 0, total)}개</span>
                <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.blue, color: '#fff' }}>정상 {total}표 집계</span>
                {panic > 0 && <span style={{ fontSize: 12.5, fontWeight: 900, padding: '6px 11px', background: T.ink, color: '#fff' }}>패닉 {panic}표 집계 제외</span>}
              </>
            )}
          </div>
        )}
        {deniable && decrypted && (
          <div style={{ fontSize: 12.5, fontWeight: 700, color: T.sub, marginBottom: 14, lineHeight: 1.55 }}>
            패닉 투표는 일반 재투표와 똑같은 모양으로 기록돼서 화면·서버·운영자 누구도 따로 구분 못 함. 먼저 낸 진짜 표는 패닉 뒤에도 그대로 집계.
          </div>
        )}
        {results ? CANDIDATES.map((c) => {
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

      {decrypted && story && (
        <Suspense fallback={<section style={{ ...box, background: T.ink, color: '#c3cdf5', fontWeight: 800, textAlign: 'center', padding: 40 }}>개표 화면 불러오는 중…</section>}>
          <TallyAnimation story={story} />
        </Suspense>
      )}

      {story && (
        <section style={{ ...box }}>
          <div style={{ ...over, marginBottom: 4 }}>집계 과정 · 표를 열지 않고 합산 <span style={{ color: T.blue }}>— 오른쪽은 게시판에서 다시 계산한 실제 값</span></div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {STEPS.map((st, i) => (
              <div key={st.t} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16, padding: '16px 0', borderTop: i ? `1px solid ${T.line}` : 'none' }}>
                <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
                  <div style={{ width: 34, height: 34, flex: 'none', background: T.blue, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 15 }}>{i + 1}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: '-0.03em' }}>{st.t}</div>
                    <div style={{ marginTop: 5, display: 'inline-block', fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, background: T.ink, color: '#fff', padding: '5px 10px', maxWidth: '100%', wordBreak: 'break-all' }}>{st.f}</div>
                    <div style={{ marginTop: 6, fontSize: 12.5, color: T.sub, fontWeight: 600, lineHeight: 1.5 }}>{st.d}</div>
                  </div>
                </div>
                <div style={{ borderLeft: `2px solid ${T.blue}`, paddingLeft: 14, minWidth: 0 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: '.12em', color: T.blue }}>실제 값</div>
                  {st.val.map((v, j) => (
                    <div key={j} style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 12.5, fontWeight: 800, color: T.ink, wordBreak: 'break-all', lineHeight: 1.4 }}>{v}</div>
                  ))}
                  {st.note && <div style={{ marginTop: 7, fontSize: 12, color: T.blue, fontWeight: 800 }}>{st.note}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <VoteTable votes={votes} shuffled={shuffled} status="CLOSED" />
    </div>
  );
}

function VerifyView({ code, setCode, run, tamper, res, fail, busy, status, rootHash }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!res?.steps) { setShown(0); return undefined; }
    setShown(0);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(res.steps.length); return undefined; }
    let i = 0;
    const timer = setInterval(() => { i += 1; setShown(i); if (i >= res.steps.length) clearInterval(timer); }, 650);
    return () => clearInterval(timer);
  }, [res]);
  const allShown = res?.steps && shown >= res.steps.length;
  const mark = { ok: ['확인', T.blue, '#fff'], fail: ['실패', '#b42318', '#fff'], skip: ['건너뜀', T.paper2, T.sub], run: ['진행 중', T.paper2, T.blue] };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 980 }}>
      {rootHash && (
        <section style={{ background: T.blue, color: '#fff', padding: '18px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: '.14em', opacity: 0.85 }}>블록체인에 공개된 봉인값</div>
          <div style={{ marginTop: 7, fontFamily: 'monospace', fontSize: 'clamp(13px,1.4vw,15px)', fontWeight: 800, wordBreak: 'break-all', lineHeight: 1.4 }}>{rootHash}</div>
          <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, opacity: 0.92 }}>내 번호로 이 값을 직접 다시 만들어서 같으면, 내 표가 빠지거나 바뀌지 않았다는 뜻</div>
        </section>
      )}
      <section style={{ ...box }}>
        <div style={over}>추적번호로 내 표 확인</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="예: 7F3A-90"
            style={{ flex: '1 1 240px', height: 46, padding: '0 14px', fontSize: 15, fontWeight: 800, fontFamily: 'monospace', border: `1.5px solid ${T.line}`, color: T.ink, outline: 'none' }} />
          <SBtn onClick={run} disabled={!!busy} solid>추적하기</SBtn>
          <SBtn onClick={tamper} disabled={!!busy || !code}>번호 한 글자 바꿔보기</SBtn>
        </div>
        {status !== 'CLOSED' && <div style={{ marginTop: 10, fontSize: 12.5, color: T.sub, fontWeight: 700 }}>게시판은 개표 뒤에 공개됨 · 먼저 [개표] 진행</div>}
        {fail && <div style={{ marginTop: 14, padding: 14, background: '#fff', border: `1.5px solid ${T.ink}`, color: T.ink, fontWeight: 800, fontSize: 13.5 }}>{fail}</div>}
      </section>

      {res?.steps && (
        <section style={{ ...box, padding: 0, overflow: 'hidden' }}>
          <div style={{ ...over, padding: '14px 18px', borderBottom: `1.5px solid ${T.line}` }}>검증 단계 · 서버를 믿지 않고 이 화면에서 직접 계산</div>
          {res.steps.map((st, i) => {
            const visible = i < shown;
            const state = visible ? st.status : i === shown ? 'run' : null;
            if (!state) return null;
            const [label, bg, fg] = mark[state];
            return (
              <div key={st.title} style={{ display: 'grid', gridTemplateColumns: '44px 1fr auto', gap: 12, alignItems: 'start', padding: '14px 18px', borderTop: i ? `1px solid ${T.line}` : 'none', animation: 'cvrow .45s ease', background: state === 'fail' ? '#fff5f4' : '#fff' }}>
                <div style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, background: state === 'fail' ? '#b42318' : state === 'skip' ? T.paper2 : T.blue, color: state === 'skip' ? T.sub : '#fff' }}>{i + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15.5, fontWeight: 900, letterSpacing: '-0.03em', color: state === 'skip' ? T.sub : T.ink }}>{st.title}</div>
                  {visible && st.lines.map((line, j) => (
                    <div key={j} style={{ marginTop: 5, fontSize: 12.5, fontWeight: 700, color: T.sub, lineHeight: 1.5, wordBreak: 'break-all', fontFamily: /[0-9a-f]{16}/.test(line) ? 'monospace' : 'inherit' }}>{line}</div>
                  ))}
                  {!visible && <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 700, color: T.blue }}>계산 진행 중…</div>}
                </div>
                <span style={{ fontSize: 12, fontWeight: 900, padding: '5px 10px', background: bg, color: fg, whiteSpace: 'nowrap' }}>{label}</span>
              </div>
            );
          })}
        </section>
      )}

      {allShown && (
        <section style={{ ...box, background: res.ok ? T.blue : (res.tampered ? T.ink : '#b42318'), color: '#fff', border: 'none' }}>
          <div style={{ fontSize: 19, fontWeight: 900, letterSpacing: '-0.03em' }}>
            {res.ok ? '내 표가 그대로 집계에 들어간 것 확인' : res.tampered ? '바뀐 번호는 통과 못 함 · 변조 탐지 확인' : '검증 실패 · 기록 확인 필요'}
          </div>
          <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, opacity: 0.92, lineHeight: 1.55 }}>
            {res.ok ? '내가 누구를 찍었는지는 열지 않고, 표가 빠지거나 바뀌지 않았다는 사실만 확인. 같은 계산은 누구나 할 수 있음.' : res.tampered ? '추적번호가 한 글자만 달라도 게시판과 봉인이 맞지 않아 바로 드러남.' : '위에서 실패한 단계를 확인.'}
          </div>
        </section>
      )}
    </div>
  );
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
