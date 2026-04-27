#!/usr/bin/env node
/**
 * benchmark/full-comparison-bench.js
 * A/B/C 3단계 Idemix 성능 비교 — 포괄적 지표 측정
 *
 * 측정 지표:
 *   1. 인증 엔드포인트 TPS (동시성별: 1/5/10/20/50)
 *   2. 레이턴시 분포 (avg, stddev, min, P50, P90, P95, P99, P99.9, max)
 *   3. Credential 발급 레이턴시 (100회)
 *   4. Credential 크기 (bytes)
 *   5. 캐시 효과 (캐시 ON/OFF 비교)
 *   6. Cold Start 레이턴시 (첫 요청)
 *   7. 스트레스 테스트 에러율 (50 workers)
 *   8. 서버 메모리 사용량 (힙 스냅샷)
 *
 * 사용법: node benchmark/full-comparison-bench.js [--url http://localhost:3000] [--out results.json]
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] ?? true;
});

const BASE_URL  = args.url || 'http://localhost:3000';
const OUT_FILE  = args.out || null;
const STEP_SEC  = parseInt(args.sec  || '12', 10);   // 동시성별 측정 시간

// ── HTTP 헬퍼 ─────────────────────────────────────────────────
function rawRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), ms }); }
        catch { resolve({ status: res.statusCode, body: buf, ms }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function makeOpts(url, method = 'GET', headers = {}) {
  const u = new URL(url);
  return { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers };
}

async function get(url, headers = {}) {
  return rawRequest(makeOpts(url, 'GET', headers));
}

async function post(url, data, headers = {}) {
  const body = JSON.stringify(data);
  return rawRequest(makeOpts(url, 'POST', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  }), body);
}

// ── 통계 계산 ─────────────────────────────────────────────────
function stats(arr) {
  if (!arr.length) return { n: 0, avg: 0, stddev: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, p999: 0, max: 0 };
  const sorted = arr.slice().sort((a, b) => a - b);
  const n   = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  const p = pct => sorted[Math.max(0, Math.ceil(pct / 100 * n) - 1)];
  return {
    n,
    avg:    +avg.toFixed(2),
    stddev: +(Math.sqrt(variance)).toFixed(2),
    min:    sorted[0],
    p50:    p(50),
    p90:    p(90),
    p95:    p(95),
    p99:    p(99),
    p999:   p(99.9),
    max:    sorted[n - 1],
  };
}

// ── TPS 측정 (단일 동시성 수준) ───────────────────────────────
async function measureTPS(label, url, headers, concurrency, durationMs) {
  const latencies = [];
  let total = 0, errors = 0, finished = false;

  async function worker() {
    while (!finished) {
      const start = process.hrtime.bigint();
      try {
        const u = new URL(url);
        await new Promise(resolve => {
          const req = http.request({
            hostname: u.hostname, port: u.port || 80,
            path: u.pathname, method: 'GET', headers,
          }, res => {
            res.resume();
            res.on('end', () => {
              total++;
              const ms = Number(process.hrtime.bigint() - start) / 1e6;
              if (res.statusCode < 500) latencies.push(ms);
              else errors++;
              resolve();
            });
          });
          req.on('error', () => { errors++; total++; resolve(); });
          req.setTimeout(5000, () => { req.destroy(); errors++; total++; resolve(); });
          req.end();
        });
      } catch { errors++; total++; }
    }
  }

  const t0 = Date.now();
  const workers = Array.from({ length: concurrency }, worker);
  await new Promise(r => setTimeout(r, durationMs));
  finished = true;
  await Promise.all(workers);

  const elapsed = (Date.now() - t0) / 1000;
  return {
    label,
    concurrency,
    durationSec:  +elapsed.toFixed(2),
    tps:          +(total / elapsed).toFixed(1),
    errorCount:   errors,
    errorRate:    +((errors / Math.max(total, 1)) * 100).toFixed(2),
    latency:      stats(latencies),
  };
}

// ── Credential 발급 레이턴시 측정 ─────────────────────────────
async function measureCredIssuance(n = 100) {
  const results = [];
  let sample = null;

  for (let i = 0; i < n; i++) {
    const r = await post(`${BASE_URL}/api/credential/idemix`, {
      enrollmentID: 'voter1', enrollmentSecret: 'voter1pw',
      electionID: `BENCH_${i}`,
    });
    if (r.status === 200 && r.body?.credential) {
      results.push(r.ms);
      if (!sample) sample = r.body;
    }
  }

  return {
    n,
    successRate: +((results.length / n) * 100).toFixed(1),
    latency:     stats(results),
    credType:    sample?.credType || 'unknown',
    credSizeBytes: sample ? Buffer.byteLength(sample.credential, 'utf8') : 0,
    payloadFields: sample ? (() => {
      try {
        const parts = sample.credential.split('.');
        const payloadPart = parts.length === 3 ? parts[1] : parts[0];
        return Object.keys(JSON.parse(Buffer.from(payloadPart, 'base64url').toString()));
      } catch { return []; }
    })() : [],
  };
}

// ── Cold Start 측정 ───────────────────────────────────────────
async function measureColdStart(url, headers, n = 20) {
  const latencies = [];
  for (let i = 0; i < n; i++) {
    const r = await get(url, headers);
    if (r.status < 500) latencies.push(r.ms);
    await new Promise(r => setTimeout(r, 50)); // 50ms 간격
  }
  return { n, latency: stats(latencies) };
}

// ── 서버 메모리 조회 ──────────────────────────────────────────
async function getServerMemory() {
  try {
    const r = await get(`${BASE_URL}/health`);
    return r.body?.memory || null;
  } catch { return null; }
}

// ── 헬스 체크 (대기 포함) ─────────────────────────────────────
async function waitForServer(maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const r = await get(`${BASE_URL}/health`);
      if (r.status === 200) return r.body;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('서버가 응답하지 않습니다.');
}

// ── 단계별 전체 측정 ──────────────────────────────────────────
async function runPhase(phaseName, note) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  [${phaseName}] ${note}`);
  console.log('═'.repeat(60));

  const health = await waitForServer();
  const idemixInfo = health?.idemix || {};
  console.log(`  모드: ${idemixInfo.mode || '?'}  impl: ${idemixInfo.impl || '?'}  캐시: ${idemixInfo.cacheEnabled}`);

  const authURL   = `${BASE_URL}/api/bench/auth`;
  const result    = { phase: phaseName, note, idemixInfo, timestamp: new Date().toISOString() };

  // ── 1. Cold Start ────────────────────────────────────────────
  console.log('\n  [1/6] Cold Start 레이턴시 (20회, 50ms 간격)...');
  result.coldStart = await measureColdStart(authURL, {}, 20);
  console.log(`  → avg: ${result.coldStart.latency.avg}ms  min: ${result.coldStart.latency.min}ms  max: ${result.coldStart.latency.max}ms`);

  // ── 2. Credential 발급 측정 (bypass 단계는 skip) ─────────────
  if (idemixInfo.mode !== 'bypass') {
    console.log('\n  [2/6] Credential 발급 레이턴시 (100회)...');
    result.credIssuance = await measureCredIssuance(100);
    console.log(`  → avg: ${result.credIssuance.latency.avg}ms  P95: ${result.credIssuance.latency.p95}ms`);
    console.log(`  → 크기: ${result.credIssuance.credSizeBytes} bytes  타입: ${result.credIssuance.credType}`);
    console.log(`  → payload 필드: [${result.credIssuance.payloadFields.join(', ')}]`);
  } else {
    console.log('\n  [2/6] Credential 발급: bypass 모드 — skip');
    result.credIssuance = null;
  }

  // ── 3. credential 헤더 준비 ──────────────────────────────────
  let credential = null;
  if (idemixInfo.mode !== 'bypass') {
    const cr = await post(`${BASE_URL}/api/credential/idemix`, {
      enrollmentID: 'voter1', enrollmentSecret: 'voter1pw', electionID: 'BENCH_FIXED',
    });
    credential = cr.body?.credential || null;
  }
  const authHeaders = credential ? { 'x-idemix-credential': credential } : {};

  // ── 4. 동시성별 TPS 곡선 ─────────────────────────────────────
  console.log('\n  [3/6] 동시성별 TPS 측정 (1→5→10→20→50 workers)...');
  result.concurrencyTPS = [];
  for (const c of [1, 5, 10, 20, 50]) {
    process.stdout.write(`  workers=${c}... `);
    const r = await measureTPS(`${phaseName}-c${c}`, authURL, authHeaders, c, STEP_SEC * 1000);
    result.concurrencyTPS.push(r);
    console.log(`TPS=${r.tps}  avg=${r.latency.avg}ms  P99=${r.latency.p99}ms  err=${r.errorCount}`);
  }

  // ── 5. 캐시 ON/OFF 비교 (idemix 모드만) ─────────────────────
  if (credential) {
    console.log('\n  [4/6] 캐시 비교 — 동일 credential 반복 요청 (500회, 단일 워커)...');
    const noCache = [];
    const withCache = [];

    // 캐시 없이 500회 (서버 IDEMIX_CACHE_ENABLED 값 그대로)
    for (let i = 0; i < 500; i++) {
      // 매번 새 credential 발급 (캐시 미스 유도)
      const cr = await post(`${BASE_URL}/api/credential/idemix`, {
        enrollmentID: 'voter1', enrollmentSecret: 'voter1pw', electionID: `CACHE_TEST_${i}`,
      });
      if (cr.body?.credential) {
        const r = await get(authURL, { 'x-idemix-credential': cr.body.credential });
        noCache.push(r.ms);
      }
    }

    // 동일 credential 반복 (캐시 히트 유도)
    for (let i = 0; i < 500; i++) {
      const r = await get(authURL, { 'x-idemix-credential': credential });
      withCache.push(r.ms);
    }

    result.cacheComparison = {
      differentCredentials: stats(noCache),
      sameCredential:       stats(withCache),
      cacheSpeedupMs:       +(stats(noCache).avg - stats(withCache).avg).toFixed(2),
      cacheSpeedupPct:      +((stats(noCache).avg - stats(withCache).avg) / stats(noCache).avg * 100).toFixed(1),
    };
    console.log(`  → 다른 credential(캐시 미스): avg=${result.cacheComparison.differentCredentials.avg}ms`);
    console.log(`  → 동일 credential(캐시 히트): avg=${result.cacheComparison.sameCredential.avg}ms`);
    console.log(`  → 캐시 효과: ${result.cacheComparison.cacheSpeedupMs}ms 단축 (${result.cacheComparison.cacheSpeedupPct}%)`);
  } else {
    result.cacheComparison = null;
  }

  // ── 6. 스트레스 테스트 (50 workers, 20초) ───────────────────
  console.log('\n  [5/6] 스트레스 테스트 (50 workers × 20초)...');
  result.stressTest = await measureTPS(`${phaseName}-stress`, authURL, authHeaders, 50, 20000);
  console.log(`  → TPS=${result.stressTest.tps}  P99=${result.stressTest.latency.p99}ms  P99.9=${result.stressTest.latency.p999}ms  에러율=${result.stressTest.errorRate}%`);

  // ── 7. 서버 메모리 ────────────────────────────────────────────
  console.log('\n  [6/6] 서버 메모리 스냅샷...');
  result.memory = await getServerMemory();
  if (result.memory) {
    console.log(`  → 힙 사용: ${(result.memory.heapUsed / 1024 / 1024).toFixed(1)} MB / ${(result.memory.heapTotal / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`  → (서버 메모리 엔드포인트 없음 — health 응답에 memory 필드 추가 권장)`);
  }

  return result;
}

// ── 비교 요약 출력 ────────────────────────────────────────────
function printSummary(phases) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  3단계 종합 비교 요약');
  console.log('═'.repeat(70));

  // TPS @ 20 workers
  console.log('\n  [인증 TPS — 20 workers]');
  const header = ['단계', 'TPS', 'avg(ms)', 'P95(ms)', 'P99(ms)', 'stddev', '에러율'];
  const colW   = [14, 10, 9, 9, 9, 9, 8];
  const row    = cells => '│' + cells.map((c, i) => String(c).padStart(colW[i])).join('│') + '│';
  const bar    = colW.map(w => '─'.repeat(w)).join('┼');
  console.log('┌' + colW.map(w => '─'.repeat(w)).join('┬') + '┐');
  console.log(row(header));
  console.log('├' + bar + '┤');
  phases.forEach(p => {
    const c20 = p.concurrencyTPS?.find(r => r.concurrency === 20);
    if (!c20) return;
    console.log(row([
      p.phase.slice(0, 13),
      c20.tps,
      c20.latency.avg,
      c20.latency.p95,
      c20.latency.p99,
      c20.latency.stddev,
      c20.errorRate + '%',
    ]));
  });
  console.log('└' + colW.map(w => '─'.repeat(w)).join('┴') + '┘');

  // Credential 크기 + 발급 레이턴시
  console.log('\n  [Credential 발급 성능]');
  phases.forEach(p => {
    if (!p.credIssuance) {
      console.log(`  ${p.phase}: bypass — 자격증명 없음`);
    } else {
      console.log(`  ${p.phase}: 크기=${p.credIssuance.credSizeBytes}B  발급avg=${p.credIssuance.latency.avg}ms  타입=${p.credIssuance.credType}`);
    }
  });

  // 스트레스 TPS
  console.log('\n  [스트레스 TPS — 50 workers × 20초]');
  phases.forEach(p => {
    if (p.stressTest) {
      console.log(`  ${p.phase}: TPS=${p.stressTest.tps}  P99.9=${p.stressTest.latency.p999}ms  에러율=${p.stressTest.errorRate}%`);
    }
  });

  // Cold Start
  console.log('\n  [Cold Start 레이턴시]');
  phases.forEach(p => {
    console.log(`  ${p.phase}: avg=${p.coldStart?.latency.avg}ms  min=${p.coldStart?.latency.min}ms  max=${p.coldStart?.latency.max}ms`);
  });
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  팀 몽바스 — Idemix 3단계 포괄 성능 비교 벤치마크');
  console.log('  측정: TPS곡선 / 레이턴시분포 / 캐시효과 / 스트레스 / 발급성능');
  console.log('═'.repeat(60));

  if (!await waitForServer(5000).catch(() => false)) {
    console.error('\n❌ 서버가 응답하지 않습니다. node src/app.js 를 먼저 실행하세요.');
    process.exit(1);
  }

  const allResults = [];

  // 서버는 외부에서 모드별로 실행됨 — 지금 연결된 서버 단계만 측정
  const health = await get(`${BASE_URL}/health`);
  const idemix = health.body?.idemix;
  const mode   = idemix?.enabled
    ? (idemix?.asymEnabled ? 'C단계 (Ed25519)' : 'B단계 (HMAC)')
    : 'A단계 (bypass)';

  console.log(`\n  현재 서버 모드: ${mode}`);
  const phaseResult = await runPhase(mode, idemix?.impl || 'bypass');
  allResults.push(phaseResult);

  printSummary(allResults);

  // JSON 저장
  const reportsDir = path.join(__dirname, '..', 'benchmark-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = OUT_FILE || path.join(reportsDir, `full-bench-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\n  ✅ JSON 저장: ${outPath}`);
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
