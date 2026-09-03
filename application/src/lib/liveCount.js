'use strict';

/**
 * lib/liveCount.js — 부스 시연용 인메모리 라이브 투표 카운터 (선거별)
 *
 * 체인코드는 진행 중(ACTIVE) 선거의 표 수를 제공하지 않으므로
 * (집계는 종료 후에만 가능), 백엔드가 성공한 투표를 선거별로 카운트한다.
 * 재투표(last-vote-wins)는 기존 표를 대체하므로 카운트하지 않는다.
 *
 * ※ 백엔드 재시작 시 초기화됨 — 시연 규모(세션당 수~수십 표)에서는 충분.
 *   실제 표/집계의 권위 있는 상태는 블록체인 원장에서 별도로 확인해야 함.
 */

const counts = new Map();

function increment(electionID) {
  const n = (counts.get(electionID) || 0) + 1;
  counts.set(electionID, n);
  return n;
}

function reset(electionID) {
  counts.set(electionID, 0);
}

function get(electionID) {
  return counts.get(electionID) || 0;
}

module.exports = { increment, reset, get };
