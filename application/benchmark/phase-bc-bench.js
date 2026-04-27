#!/usr/bin/env node
/**
 * benchmark/phase-bc-bench.js
 * B단계(현재 HMAC Idemix) + C단계(개선 후) 통합 성능 측정 스크립트
 *
 * 측정 항목:
 *   1. Credential 발급 레이턴시 (100회)
 *   2. Credential 크기 (bytes)
 *   3. 인증 엔드포인트 TPS (bypass / HMAC / HMAC+캐시 / BBS+ / BBS++캐시)
 *
 * 사용법:
 *   # HMAC 모드 (B단계)
 *   IDEMIX_ENABLED=true node src/app.js
 *   node benchmark/phase-bc-bench.js --mode hmac
 *
 *   # BBS+ 모드 (C단계)
 *   IDEMIX_ENABLED=true BBS_ENABLED=true node src/app.js
 *   node benchmark/phase-bc-bench.js --mode bbs
 *
 *   # 전체 비교 (서버 두 번 재시작 필요)
 *   node benchmark/phase-bc-bench.js --mode all
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── CLI 인수 파싱 ─────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) args[arg.slice(2)] = arr[i + 1] ?? true;
});

const BASE_URL    = args.url      || 'http://localhost:3000';
const DURATION_MS = parseInt(args.duration || '15', 10) * 1000;
const CONCURRENCY = parseInt(args.concur   || '20', 10);
const CRED_ITER   = parseInt(args.crediter || '100', 10);
const MODE        = args.mode || 'all';  // 'hmac' | 'bbs' | 'all'

// ── HTTP 유틸 ─────────────────────────────────────────────────
function httpRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const ms = Date.now() - start;
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

function get(url) {
  const u = new URL(url);
  return httpRequest({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET' });
}

function post(url, data) {
  const body = JSON.stringify(data);
  const u = new URL(url);
  return httpRequest({
    hostname: u.hostname, port: u.port || 80, path: u.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

function getWithHeader(url, headers) {
  const u = new URL(url);
  return new Promise(resolve => {
    const start = Date.now();
    const req = http.request({
      hostname: u.hostname, port: u.port || 80,
      path: u.pathname + u.search, method: 'GET', headers,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 500, statusCode: res.statusCode, ms: Date.now() - start }));
    });
    req.on('error', () => resolve({ ok: false, statusCode: 0, ms: Date.now() - start }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, statusCode: 0, ms: 5000 }); });
    req.end();
  });
}

// ── 서버 확인 ─────────────────────────────────────────────────
async function checkServer() {
  try {
    const r = await get(`${BASE_URL}/health`);
    return r.status === 200;
  } catch { return false; }
}

// ── Credential 발급 측정 ──────────────────────────────────────
async function measureCredentialIssuance(iterations = 100) {
  console.log(`\n[Credential 발급 레이턴시 측정] ${iterations}회`);
  const latencies = [];
  let failures = 0;
  let credentialSample = null;
  let credentialSize = 0;

  for (let i = 0; i < iterations; i++) {
    try {
      const r = await post(`${BASE_URL}/api/credential/idemix`, {
        enrollmentID:     'voter1',
        enrollmentSecret: 'voter1pw',
        electionID:       `BENCH_ELECTION_${i}`,
      });
      if (r.status === 200 && r.body.credential) {
        latencies.push(r.ms);
        if (!credentialSample) {
          credentialSample = r.body.credential;
          credentialSize   = Buffer.byteLength(credentialSample, 'utf8');
        }
      } else {
        failures++;
      }
    } catch { failures++; }
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const avg    = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const p = pct => sorted.length ? sorted[Math.max(0, Math.ceil(pct / 100 * sorted.length) - 1)] : 0;

  console.log(`  성공: ${latencies.length}/${iterations}  실패: ${failures}`);
  console.log(`  avg: ${avg.toFixed(1)}ms  P50: ${p(50)}ms  P95: ${p(95)}ms  P99: ${p(99)}ms`);
  console.log(`  credential 크기: ${credentialSize} bytes`);

  return {
    iterations,
    successCount: latencies.length,
    failureCount: failures,
    avgMs:    parseFloat(avg.toFixed(1)),
    p50Ms:    p(50),
    p95Ms:    p(95),
    p99Ms:    p(99),
    credentialSizeBytes: credentialSize,
    credentialSample,
  };
}

// ── TPS 측정 (단일 시나리오) ──────────────────────────────────
async function runTPS(name, url, headers = {}) {
  const latencies = [];
  let totalReqs = 0, failedReqs = 0, finished = false;

  async function worker() {
    while (!finished) {
      const r = await getWithHeader(url, headers);
      totalReqs++;
      if (!r.ok) failedReqs++;
      else latencies.push(r.ms);
    }
  }

  const startTime = Date.now();
  const workers   = Array.from({ length: CONCURRENCY }, worker);

  const tick = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  [${name}] ${elapsed}s / ${DURATION_MS / 1000}s  요청: ${totalReqs}  `);
  }, 500);

  await new Promise(r => setTimeout(r, DURATION_MS));
  finished = true;
  await Promise.all(workers);
  clearInterval(tick);
  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  const elapsed = (Date.now() - startTime) / 1000;
  const sorted  = latencies.slice().sort((a, b) => a - b);
  const p = pct => sorted.length ? sorted[Math.max(0, Math.ceil(pct / 100 * sorted.length) - 1)] : 0;
  const avg = sorted.length ? (sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;

  return {
    name,
    tps:       parseFloat((totalReqs / elapsed).toFixed(1)),
    totalReqs,
    failedReqs,
    avgMs:     parseFloat(avg.toFixed(1)),
    p50Ms:     p(50),
    p95Ms:     p(95),
    p99Ms:     p(99),
  };
}

// ── 인증 TPS 시나리오 실행 ────────────────────────────────────
async function runAuthTPSBenchmark(credential) {
  const authURL = `${BASE_URL}/api/bench/auth`;
  const results = [];

  console.log(`\n[인증 엔드포인트 TPS 벤치마크]  동시성: ${CONCURRENCY}  시간: ${DURATION_MS / 1000}초`);

  // STEP 1: bypass
  console.log('\n  STEP 1: bypass (IDEMIX_ENABLED=false 서버 필요)');
  results.push(await runTPS('bypass', authURL, {}));
  console.log(`  → TPS: ${results[0].tps}  avg: ${results[0].avgMs}ms  실패: ${results[0].failedReqs}`);

  // STEP 2: Idemix (credential 없음)
  console.log('\n  STEP 2: Idemix (credential 헤더 없음)');
  results.push(await runTPS('idemix-no-cred', authURL, {}));
  console.log(`  → TPS: ${results[1].tps}  avg: ${results[1].avgMs}ms  실패: ${results[1].failedReqs}`);

  if (credential) {
    // STEP 3: Idemix + valid credential
    console.log('\n  STEP 3: Idemix + valid credential');
    results.push(await runTPS('idemix-valid', authURL, { 'x-idemix-credential': credential }));
    console.log(`  → TPS: ${results[2].tps}  avg: ${results[2].avgMs}ms  실패: ${results[2].failedReqs}`);

    // STEP 4: Idemix + valid credential + 캐시 (서버에 IDEMIX_CACHE_ENABLED=true 설정 필요)
    console.log('\n  STEP 4: Idemix + valid credential + 캐시');
    results.push(await runTPS('idemix-cached', authURL, { 'x-idemix-credential': credential }));
    console.log(`  → TPS: ${results[3].tps}  avg: ${results[3].avgMs}ms  실패: ${results[3].failedReqs}`);
  }

  return results;
}

// ── 결과 출력 테이블 ──────────────────────────────────────────
function printTable(results) {
  const colW = [32, 10, 9, 7, 7, 7, 7];
  const header = ['시나리오', 'TPS', 'avg(ms)', 'P50', 'P95', 'P99', '실패'];
  const bar = colW.map(w => '─'.repeat(w)).join('┼');
  const row = cells => '│' + cells.map((c, i) => String(c).padStart(colW[i])).join('│') + '│';

  console.log('\n┌' + colW.map(w => '─'.repeat(w)).join('┬') + '┐');
  console.log(row(header));
  console.log('├' + bar + '┤');
  results.forEach((r, idx) => {
    const base = results[0];
    const diff = idx > 0 && base ? ` (${r.tps >= base.tps ? '+' : ''}${((r.tps - base.tps) / base.tps * 100).toFixed(1)}%)` : '';
    console.log(row([
      r.name.slice(0, 31),
      r.tps + diff,
      r.avgMs,
      r.p50Ms,
      r.p95Ms,
      r.p99Ms,
      r.failedReqs,
    ]));
  });
  console.log('└' + colW.map(w => '─'.repeat(w)).join('┴') + '┘');
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  팀 몽바스 — Phase B/C Idemix 성능 비교 벤치마크');
  console.log(`  모드: ${MODE.toUpperCase()}  |  대상: ${BASE_URL}`);
  console.log('══════════════════════════════════════════════════════\n');

  if (!await checkServer()) {
    console.error('❌ 서버가 응답하지 않습니다.');
    console.error('   IDEMIX_ENABLED=true node src/app.js 를 먼저 실행하세요.\n');
    process.exit(1);
  }

  const health = await get(`${BASE_URL}/health`);
  const idemix = health.body?.idemix;
  console.log(`  서버 상태: ${health.body?.status}`);
  console.log(`  Idemix 활성: ${idemix?.enabled}  모드: ${idemix?.mode}  캐시: ${idemix?.cacheEnabled}`);

  // ── 1. Credential 발급 레이턴시 측정 ─────────────────────
  const credResult = await measureCredentialIssuance(CRED_ITER);

  // ── 2. 인증 TPS 측정 ──────────────────────────────────────
  const tpsResults = await runAuthTPSBenchmark(credResult.credentialSample);
  printTable(tpsResults);

  // ── 3. 결과 요약 ──────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  측정 요약');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Credential 발급:`);
  console.log(`    avg: ${credResult.avgMs}ms  P95: ${credResult.p95Ms}ms`);
  console.log(`    크기: ${credResult.credentialSizeBytes} bytes`);
  if (tpsResults.length >= 3) {
    const base  = tpsResults[0];
    const hmac  = tpsResults[2];
    console.log(`  인증 오버헤드 (bypass → HMAC valid):`);
    console.log(`    TPS:  ${base.tps} → ${hmac.tps} (${((hmac.tps - base.tps) / base.tps * 100).toFixed(1)}%)`);
    console.log(`    avg:  ${base.avgMs}ms → ${hmac.avgMs}ms (+${(hmac.avgMs - base.avgMs).toFixed(1)}ms)`);
  }

  // ── 4. JSON 저장 ──────────────────────────────────────────
  const reportsDir = path.join(__dirname, '..', 'benchmark-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const fname = path.join(reportsDir, `phase-bc-bench-${MODE}-${Date.now()}.json`);
  fs.writeFileSync(fname, JSON.stringify({
    mode: MODE,
    timestamp: new Date().toISOString(),
    environment: { baseUrl: BASE_URL, concurrency: CONCURRENCY, durationMs: DURATION_MS },
    credentialIssuance: credResult,
    authTPS: tpsResults,
  }, null, 2));
  console.log(`\n  JSON 저장: ${fname}`);
  console.log('══════════════════════════════════════════════════════\n');

  // ── 5. 보고서 업데이트 힌트 ──────────────────────────────
  console.log('  ✏️  다음 단계: 위 수치를 IDEMIX_COMPARISON_REPORT.md의 B단계(TBD)에 입력하세요.');
  console.log('  ✏️  BBS+ 모드 서버 실행 후 --mode bbs 로 C단계 측정을 진행하세요.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
