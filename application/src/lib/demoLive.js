'use strict';

/**
 * lib/demoLive.js — 부스 시연용 인메모리 라이브 채널 (선거별)
 *
 *  ① 라이브 암호문 목록   : 투표가 들어올 때마다 {무효화 해시, ElGamal 암호문(c1,c2), ZKP결과} 누적
 *                          → 대시보드가 폴링해 "암호화된 투표" 표를 새로고침 없이 실시간 갱신
 *  ② 셔플                : 개표(게시판 공개) 시 도착순서를 섞어 시간 상관(timing) 제거를 시각화
 *  ③ 이벤트 버스         : 모바일 ↔ 대시보드 (검증하기 누르면 대시보드가 검증 뷰로 전환 등)
 *
 *  ※ 백엔드 재시작 시 초기화 — 시연 규모(세션당 수~수십 표)에 충분.
 *    실제 표/집계/게시판의 권위 있는 상태와 보안성은 원장·bundle 검증으로 별도 확인.
 */

const votesMap = new Map();   // electionID -> [{ seq, nh, c1, c2, zkp, ts, revoted }]  (도착 순서)
const orderMap = new Map();   // electionID -> number[] | null  (셔플된 표시 순서)
const eventsMap = new Map();  // electionID -> [{ seq, type, payload, ts }]
let evSeq = 0;

const now = () => Date.now();

function recordVote(electionID, { nullifierHash, ciphertext, zkpValid }) {
  let arr = votesMap.get(electionID);
  if (!arr) { arr = []; votesMap.set(electionID, arr); }
  const [c1, c2] = String(ciphertext || '').split(':');
  const existing = arr.find((v) => v.nh === nullifierHash);
  if (existing) {                                   // 재투표(last-vote-wins): 기존 행 교체
    existing.c1 = c1; existing.c2 = c2; existing.zkp = zkpValid !== false; existing.ts = now(); existing.revoted = true;
  } else {
    arr.push({ seq: arr.length + 1, nh: nullifierHash, c1, c2, zkp: zkpValid !== false, ts: now() });
  }
  // 셔플 이후 새 표가 들어오면 셔플 무효화(다시 도착순서로) — 보통 개표 후엔 투표 안 들어옴
  orderMap.set(electionID, null);
  pushEvent(electionID, 'vote', { nullifierHash });
}

function listVotes(electionID) {
  const arr = votesMap.get(electionID) || [];
  const order = orderMap.get(electionID);
  const view = order ? order.map((i) => arr[i]).filter(Boolean) : arr;
  return {
    shuffled: !!order,
    count: arr.length,
    votes: view.map((v) => ({ seq: v.seq, nh: v.nh, c1: v.c1, c2: v.c2, zkp: v.zkp, ts: v.ts, revoted: !!v.revoted })),
  };
}

function shuffle(electionID) {
  const arr = votesMap.get(electionID) || [];
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  orderMap.set(electionID, idx);
  pushEvent(electionID, 'shuffle', { count: arr.length });
}

function reset(electionID) {
  votesMap.set(electionID, []);
  orderMap.set(electionID, null);
  eventsMap.set(electionID, []);
}

function pushEvent(electionID, type, payload) {
  let arr = eventsMap.get(electionID);
  if (!arr) { arr = []; eventsMap.set(electionID, arr); }
  arr.push({ seq: ++evSeq, type, payload: payload || {}, ts: now() });
  if (arr.length > 80) arr.shift();
}

function listEvents(electionID, since) {
  const arr = eventsMap.get(electionID) || [];
  const s = parseInt(since, 10) || 0;
  return { lastSeq: evSeq, events: arr.filter((e) => e.seq > s) };
}

module.exports = { recordVote, listVotes, shuffle, reset, pushEvent, listEvents };
