#!/usr/bin/env node
/**
 * 동시 투표 인원 수 증가에 따른 병목 판단 측정
 *
 * 측정 항목:
 *   - 동시 투표 수(concurrency) 별 레이턴시 분포 (avg/p50/p95/p99)
 *   - 실제 달성 TPS
 *   - 실패율 (트랜잭션 거부 / 타임아웃)
 *   - 병목 구간 판단 (Gateway 연결 / BatchTimeout / Endorsement)
 *
 * 측정 조건:
 *   - 각 동시성 수준: 5배치 반복
 *   - 각 유권자는 고유한 nullifierHash 사용 (이중투표 없음)
 *   - nullifierHash = SHA256("bench-secret-{i}" + electionID)
 */

'use strict';

const crypto = require('crypto');
const API         = 'http://localhost:3000';
const ELECTION_ID = 'bench-concurrent-1776084981';
const CANDIDATES  = ['A', 'B', 'C'];
const BATCHES     = 5;   // 각 동시성 수준에서 반복 배치 수
const CONCURRENCIES = [1, 5, 10, 20, 50, 100];

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function makeNullifier(secret) {
  return crypto.createHash('sha256').update(secret + ELECTION_ID).digest('hex');
}

function pickCandidate(i) {
  return CANDIDATES[i % CANDIDATES.length];
}

function stats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  const stddev = Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
  return {
    n,
    avg:    +avg.toFixed(1),
    stddev: +stddev.toFixed(1),
    min:    sorted[0],
    max:    sorted[n - 1],
    p50:    sorted[Math.floor(n * 0.50)],
    p95:    sorted[Math.floor(n * 0.95)],
    p99:    sorted[Math.floor(n * 0.99)] ?? sorted[n - 1],
  };
}

// ── 단일 투표 요청 ─────────────────────────────────────────────────────────────
async function castVote(nullifierHash, candidateID, voterID) {
  const start = Date.now();
  try {
    const res = await fetch(`${API}/api/vote`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ electionID: ELECTION_ID, candidateID, nullifierHash, voterID }),
    });
    const body = await res.json();
    const latency = Date.now() - start;
    const ok = res.ok && !body.error;
    return { ok, latency, status: res.status, error: body.error ?? null };
  } catch (e) {
    return { ok: false, latency: Date.now() - start, status: 0, error: e.message };
  }
}

// ── 한 배치 실행: concurrency개 요청 동시 발행 ────────────────────────────────
let globalVoterIdx = 0;

async function runBatch(concurrency) {
  const promises = [];
  for (let i = 0; i < concurrency; i++) {
    const idx      = globalVoterIdx++;
    const secret   = `bench-secret-concurrent-${idx}-${Date.now()}`;
    const nullifier = makeNullifier(secret);
    const candidate = pickCandidate(idx);
    const voterID  = `voter-${idx}`;
    promises.push(castVote(nullifier, candidate, voterID));
  }
  const batchStart = Date.now();
  const results    = await Promise.all(promises);
  const batchTime  = Date.now() - batchStart;   // 배치 전체 소요 시간
  return { results, batchTime };
}

// ── 동시성 수준 하나 전체 측정 ────────────────────────────────────────────────
async function measureConcurrency(concurrency) {
  const allLatencies = [];
  const allErrors    = [];
  let   totalOk      = 0;
  let   totalFail    = 0;
  let   totalBatchMs = 0;

  for (let b = 0; b < BATCHES; b++) {
    const { results, batchTime } = await runBatch(concurrency);
    totalBatchMs += batchTime;

    for (const r of results) {
      allLatencies.push(r.latency);
      if (r.ok) {
        totalOk++;
      } else {
        totalFail++;
        allErrors.push(r.error);
      }
    }
    process.stdout.write(`\r  동시 ${String(concurrency).padStart(3)}: 배치 ${b + 1}/${BATCHES} 완료`);
    // 배치 간 짧은 휴식 (블록 확정 대기)
    if (b < BATCHES - 1) await new Promise(r => setTimeout(r, 200));
  }

  const total   = totalOk + totalFail;
  // TPS = 총 성공 건수 / 전체 배치 실행 시간(초)
  const tps     = +(totalOk / (totalBatchMs / 1000)).toFixed(2);
  const failRate = +((totalFail / total) * 100).toFixed(1);

  // 오류 유형 분류
  const errTypes = {};
  for (const e of allErrors) {
    const key = e ? e.slice(0, 60) : 'unknown';
    errTypes[key] = (errTypes[key] ?? 0) + 1;
  }

  return {
    concurrency,
    total,
    ok:       totalOk,
    fail:     totalFail,
    failRate,
    tps,
    totalBatchMs,
    latency:  stats(allLatencies),
    errTypes,
  };
}

// ── 병목 판단 로직 ─────────────────────────────────────────────────────────────
function diagnosBottleneck(row, batchTimeout = 2000) {
  const { concurrency, tps, latency, failRate } = row;
  if (!latency) return '측정 불가';

  // 1. 실패율 급증 → Endorsement / Gateway 포화
  if (failRate > 20) return `❌ Endorsement/Gateway 포화 (실패율 ${failRate}%)`;

  // 2. avg가 BatchTimeout의 배수에 근접 → BatchTimeout 지배
  const btMultiple = Math.round(latency.avg / batchTimeout);
  if (btMultiple >= 1 && Math.abs(latency.avg - btMultiple * batchTimeout) < batchTimeout * 0.15) {
    return `⏱  BatchTimeout 지배 (avg≈${btMultiple}×${batchTimeout}ms)`;
  }

  // 3. concurrency 증가해도 TPS 정체 → Gateway 직렬화
  return `🔗 Gateway 직렬 처리 (TPS=${tps}, avg=${latency.avg}ms)`;
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== 동시 투표 인원 수 증가에 따른 병목 판단 측정 ===');
  console.log(`대상 선거  : ${ELECTION_ID}`);
  console.log(`배치 반복  : ${BATCHES}회 / 동시성 수준`);
  console.log(`동시성 수준: ${CONCURRENCIES.join(', ')}`);
  console.log('');

  // 사전 확인
  const infoRes = await fetch(`${API}/api/elections/${ELECTION_ID}`);
  const info    = await infoRes.json();
  if (info.status !== 'ACTIVE') {
    console.error(`❌ 선거 상태가 ACTIVE가 아닙니다: ${info.status}`);
    process.exit(1);
  }
  console.log(`선거 상태: ${info.status} ✅`);
  console.log('');

  const results = [];

  for (const c of CONCURRENCIES) {
    const row = await measureConcurrency(c);
    results.push(row);
    console.log('');
  }

  // ── 결과 테이블 ──────────────────────────────────────────────────────────
  console.log('');
  console.log('='.repeat(80));
  console.log('[측정 결과 — 레이턴시]');
  console.log('');
  console.log('| 동시 투표 수 | 총 요청 | 성공 | 실패율 | avg | stddev | p50 | p95 | p99 | max |');
  console.log('|------------|--------|------|--------|-----|--------|-----|-----|-----|-----|');
  for (const r of results) {
    const l = r.latency;
    console.log(
      `| ${String(r.concurrency).padEnd(12)} | ${String(r.total).padEnd(6)} | ${String(r.ok).padEnd(4)} | ${String(r.failRate+'%').padEnd(6)} | ${l.avg}ms | ${l.stddev}ms | ${l.p50}ms | ${l.p95}ms | ${l.p99}ms | ${l.max}ms |`
    );
  }

  console.log('');
  console.log('[측정 결과 — TPS 및 병목 판단]');
  console.log('');
  console.log('| 동시 투표 수 | 실제 TPS | 총 소요 시간 | 병목 판단 |');
  console.log('|------------|---------|------------|---------|');
  for (const r of results) {
    const diag = diagnosBottleneck(r);
    console.log(
      `| ${String(r.concurrency).padEnd(12)} | ${String(r.tps).padEnd(9)} | ${r.totalBatchMs}ms | ${diag} |`
    );
  }

  // ── TPS 추이 분석 ─────────────────────────────────────────────────────────
  console.log('');
  console.log('[TPS 추이 — 병목 판단 근거]');
  console.log('');
  const tpsArr = results.map(r => r.tps);
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const curr = results[i];
    const tpsGrowth = curr.tps - prev.tps;
    const concGrowth = curr.concurrency / prev.concurrency;
    const efficiency = (tpsGrowth / prev.tps / (concGrowth - 1) * 100).toFixed(0);
    console.log(
      `  동시 ${prev.concurrency} → ${curr.concurrency}: TPS ${prev.tps} → ${curr.tps} ` +
      `(+${tpsGrowth.toFixed(2)}, 동시성 ${concGrowth}x 증가 대비 효율 ${efficiency}%)`
    );
  }

  // ── 오류 유형 집계 ────────────────────────────────────────────────────────
  const allErrTypes = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.errTypes)) {
      allErrTypes[k] = (allErrTypes[k] ?? 0) + v;
    }
  }
  if (Object.keys(allErrTypes).length > 0) {
    console.log('');
    console.log('[오류 유형 집계]');
    for (const [k, v] of Object.entries(allErrTypes)) {
      console.log(`  ${v}회: ${k}`);
    }
  }

  // ── 종합 분석 ────────────────────────────────────────────────────────────
  console.log('');
  console.log('[종합 병목 분석]');
  const maxTps    = Math.max(...tpsArr);
  const satPoint  = results.find(r => r.tps >= maxTps * 0.95);
  const failStart = results.find(r => r.failRate > 5);
  console.log(`  최대 달성 TPS      : ${maxTps}`);
  console.log(`  TPS 포화 시작 구간  : 동시 ${satPoint?.concurrency ?? '?'}명`);
  console.log(`  실패율 5% 초과 구간 : ${failStart ? '동시 ' + failStart.concurrency + '명' : '없음 (전 구간 안정)'}`);

  // ── JSON 저장 ─────────────────────────────────────────────────────────────
  const fs = require('fs');
  const out = {
    measuredAt:  new Date().toISOString(),
    electionID:  ELECTION_ID,
    scenario:    'concurrent-vote-bottleneck',
    batches:     BATCHES,
    results,
  };
  const outPath = `${__dirname}/../docs/security-eval/extended/concurrent-vote-results.json`;
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n원시 데이터 저장: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
