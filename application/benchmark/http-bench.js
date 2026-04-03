#!/usr/bin/env node
/**
 * benchmark/http-bench.js — Idemix 성능 영향 HTTP 벤치마크
 *
 * 사용법:
 *   node benchmark/http-bench.js [옵션]
 *
 * 옵션:
 *   --url      테스트 대상 URL  (기본: http://localhost:3000/api/bench/auth)
 *   --duration 실행 시간 (초)   (기본: 15)
 *   --concur   동시 요청 수     (기본: 10)
 *
 * 성능 비교 3단계:
 *   1) 기준선:  IDEMIX_ENABLED=false  node src/app.js  →  node benchmark/http-bench.js
 *   2) Idemix:  IDEMIX_ENABLED=true IDEMIX_SIMULATE_MS=50  node src/app.js  →  node benchmark/http-bench.js
 *   3) 최적화:  IDEMIX_ENABLED=true IDEMIX_SIMULATE_MS=50 IDEMIX_CACHE_ENABLED=true  →  node benchmark/http-bench.js
 */

'use strict';

const http  = require('http');
const https = require('https');

// ── CLI 인수 파싱 ────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) args[arg.slice(2)] = arr[i + 1];
});

const TARGET_URL  = args.url      || 'http://localhost:3000/api/bench/auth';
const DURATION_MS = (parseInt(args.duration || '15', 10)) * 1000;
const CONCURRENCY = parseInt(args.concur || '10', 10);

// ── 결과 수집 ────────────────────────────────────────────────────
const latencies = [];
let totalReqs   = 0;
let failedReqs  = 0;
let finished    = false;

function makeRequest(url) {
  return new Promise((resolve) => {
    const start   = Date.now();
    const lib     = url.startsWith('https') ? https : http;
    const req     = lib.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 500, ms: Date.now() - start }));
    });
    req.on('error', () => resolve({ ok: false, ms: Date.now() - start }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, ms: 5000 }); });
  });
}

async function worker() {
  while (!finished) {
    const result = await makeRequest(TARGET_URL);
    totalReqs++;
    if (!result.ok) failedReqs++;
    else latencies.push(result.ms);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatTable(rows) {
  const colW = [28, 12, 12, 12, 12, 12, 12];
  const hr   = colW.map(w => '─'.repeat(w)).join('┼');
  const row  = (cells) => cells.map((c, i) => String(c).padStart(colW[i])).join('│');

  console.log('┌' + colW.map(w => '─'.repeat(w)).join('┬') + '┐');
  console.log('│' + row(['지표', '값', '', '', '', '', '']) + '│');
  console.log('├' + hr + '┤');
  rows.forEach(r => console.log('│' + row(r) + '│'));
  console.log('└' + colW.map(w => '─'.repeat(w)).join('┴') + '┘');
}

async function main() {
  const parsed = new URL(TARGET_URL);
  console.log('\n══════════════════════════════════════════════');
  console.log('  팀 몽바스 — Idemix 인증 HTTP 벤치마크');
  console.log('══════════════════════════════════════════════');
  console.log(`  대상:    ${TARGET_URL}`);
  console.log(`  동시성:  ${CONCURRENCY} workers`);
  console.log(`  시간:    ${DURATION_MS / 1000}s`);
  console.log('══════════════════════════════════════════════\n');

  // 서버 응답 확인
  try {
    await makeRequest(`http://${parsed.hostname}:${parsed.port || 3000}/health`);
  } catch {
    console.error('❌ 서버가 응답하지 않습니다. node src/app.js 를 먼저 실행하세요.');
    process.exit(1);
  }

  const startTime = Date.now();
  const workers   = Array.from({ length: CONCURRENCY }, () => worker());

  // 진행 상황 출력
  const tick = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r  진행: ${elapsed}s / ${DURATION_MS/1000}s   요청: ${totalReqs}   실패: ${failedReqs}   `);
  }, 500);

  await new Promise(r => setTimeout(r, DURATION_MS));
  finished = true;
  await Promise.all(workers);
  clearInterval(tick);
  process.stdout.write('\n');

  // ── 결과 계산 ─────────────────────────────────────────────────
  const elapsed = (Date.now() - startTime) / 1000;
  const sorted  = latencies.slice().sort((a, b) => a - b);
  const tps     = (totalReqs / elapsed).toFixed(1);
  const avgMs   = sorted.length ? (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1) : 0;

  console.log('\n══════════════════════════════════════════════');
  console.log('  결과');
  console.log('══════════════════════════════════════════════');
  console.log(`  총 요청수:    ${totalReqs}`);
  console.log(`  성공:         ${totalReqs - failedReqs}`);
  console.log(`  실패:         ${failedReqs}`);
  console.log(`  TPS:          ${tps} req/s`);
  console.log(`  평균 레이턴시: ${avgMs} ms`);
  console.log(`  P50:          ${percentile(sorted, 50)} ms`);
  console.log(`  P95:          ${percentile(sorted, 95)} ms`);
  console.log(`  P99:          ${percentile(sorted, 99)} ms`);
  console.log(`  최대:          ${sorted[sorted.length - 1] || 0} ms`);
  console.log('══════════════════════════════════════════════');

  // JSON 저장 (자동화 비교용)
  const report = {
    timestamp:   new Date().toISOString(),
    target:      TARGET_URL,
    concurrency: CONCURRENCY,
    durationSec: elapsed,
    totalReqs,
    failedReqs,
    tps:         parseFloat(tps),
    latency: {
      avgMs:  parseFloat(avgMs),
      p50Ms:  percentile(sorted, 50),
      p95Ms:  percentile(sorted, 95),
      p99Ms:  percentile(sorted, 99),
      maxMs:  sorted[sorted.length - 1] || 0,
    },
  };

  const fs       = require('fs');
  const path     = require('path');
  const reportsDir = path.join(__dirname, '..', 'benchmark-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const fname = path.join(reportsDir, `auth-bench-${Date.now()}.json`);
  fs.writeFileSync(fname, JSON.stringify(report, null, 2));
  console.log(`\n  JSON 저장: ${fname}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
