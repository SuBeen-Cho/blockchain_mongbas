#!/usr/bin/env node
/**
 * benchmark/idemix-bench.js — Idemix 3단계 자동 성능 비교 벤치마크
 *
 * 이 스크립트 하나로 3단계를 자동 실행하고 비교표를 출력합니다.
 *
 * 사용법:
 *   node benchmark/idemix-bench.js [--duration 15] [--concur 10]
 *
 * 실행 전 준비:
 *   IDEMIX_ENABLED=false node src/app.js         (STEP 1 기준선)
 *   IDEMIX_ENABLED=true  node src/app.js         (STEP 2/3 Idemix)
 *
 * 또는 서버를 띄우지 않고 각 단계 환경변수를 바꿔가며 이 스크립트를 실행하세요.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) args[arg.slice(2)] = arr[i + 1];
});

const BASE_URL    = args.url      || 'http://localhost:3000';
const DURATION_MS = parseInt(args.duration || '15', 10) * 1000;
const CONCURRENCY = parseInt(args.concur   || '10', 10);

// ── 테스트할 시나리오 정의 ───────────────────────────────────────
const SCENARIOS = [
  {
    name:    'STEP 1 — bypass (Idemix 비활성)',
    url:     `${BASE_URL}/api/bench/auth`,
    headers: {},
    desc:    'IDEMIX_ENABLED=false 상태에서의 기준선',
  },
  {
    name:    'STEP 2 — Idemix (캐시 없음, credential 없음)',
    url:     `${BASE_URL}/api/bench/auth`,
    headers: {},
    desc:    'IDEMIX_ENABLED=true, credential 헤더 없어 403 예상 (레이턴시 측정)',
  },
  {
    name:    'STEP 3 — Idemix (valid credential)',
    url:     `${BASE_URL}/api/bench/auth`,
    headers: {}, // 아래 fetchCredential()로 채워짐
    desc:    'IDEMIX_ENABLED=true, 유효한 credential 포함',
  },
  {
    name:    'STEP 4 — Idemix + 캐시 (valid credential)',
    url:     `${BASE_URL}/api/bench/auth`,
    headers: {}, // 아래 fetchCredential()로 채워짐
    desc:    'IDEMIX_ENABLED=true, IDEMIX_CACHE_ENABLED=true',
  },
];

// ── 자격증명 발급 ────────────────────────────────────────────────
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = new URL(url);
    const req  = http.request({
      hostname: opts.hostname,
      port:     opts.port || 80,
      path:     opts.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function fetchCredential(electionID = 'TEST_ELECTION') {
  try {
    const res = await httpPost(`${BASE_URL}/api/credential/idemix`, {
      enrollmentID:     'voter1',
      enrollmentSecret: 'voter1pw',
      electionID,
    });
    return res.body.credential || null;
  } catch {
    return null;
  }
}

// ── HTTP GET 요청 (헤더 포함) ────────────────────────────────────
function makeRequest(url, headers = {}) {
  return new Promise((resolve) => {
    const opts   = new URL(url);
    const start  = Date.now();
    const reqOpts = {
      hostname: opts.hostname,
      port:     opts.port || 80,
      path:     opts.pathname + opts.search,
      method:   'GET',
      headers,
    };
    const req = http.request(reqOpts, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 500, statusCode: res.statusCode, ms: Date.now() - start }));
    });
    req.on('error', () => resolve({ ok: false, statusCode: 0, ms: Date.now() - start }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, statusCode: 0, ms: 5000 }); });
    req.end(); // GET이어도 http.request는 반드시 호출 필요
  });
}

// ── 단일 시나리오 실행 ───────────────────────────────────────────
async function runScenario(scenario) {
  const latencies = [];
  let totalReqs   = 0;
  let failedReqs  = 0;
  let finished    = false;

  async function worker() {
    while (!finished) {
      const r = await makeRequest(scenario.url, scenario.headers);
      totalReqs++;
      if (!r.ok) failedReqs++;
      else latencies.push(r.ms);
    }
  }

  const startTime = Date.now();
  const workers   = Array.from({ length: CONCURRENCY }, worker);

  process.stdout.write(`  실행 중...`);
  const tick = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  진행: ${elapsed}s / ${DURATION_MS / 1000}s   요청: ${totalReqs}   `);
  }, 500);

  await new Promise(r => setTimeout(r, DURATION_MS));
  finished = true;
  await Promise.all(workers);
  clearInterval(tick);
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  const elapsed = (Date.now() - startTime) / 1000;
  const sorted  = latencies.slice().sort((a, b) => a - b);
  const p = (pct) => sorted.length ? sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)] : 0;
  const avg = sorted.length ? (sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1) : 0;

  return {
    name:      scenario.name,
    desc:      scenario.desc,
    tps:       parseFloat((totalReqs / elapsed).toFixed(1)),
    totalReqs,
    failedReqs,
    avgMs:     parseFloat(avg),
    p50Ms:     p(50),
    p95Ms:     p(95),
    p99Ms:     p(99),
    maxMs:     sorted[sorted.length - 1] || 0,
  };
}

// ── 서버 연결 확인 ───────────────────────────────────────────────
async function checkServer() {
  try {
    await makeRequest(`${BASE_URL}/health`);
    return true;
  } catch {
    return false;
  }
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  팀 몽바스 — Idemix 4단계 성능 비교 벤치마크');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  대상:    ${BASE_URL}`);
  console.log(`  동시성:  ${CONCURRENCY} workers`);
  console.log(`  단계당:  ${DURATION_MS / 1000}초`);
  console.log('══════════════════════════════════════════════════════\n');

  if (!await checkServer()) {
    console.error('❌ 서버가 응답하지 않습니다.');
    console.error('   node src/app.js 를 먼저 실행하세요.\n');
    process.exit(1);
  }

  // credential 사전 발급 (STEP 3, 4용)
  console.log('  credential 발급 중...');
  const credential = await fetchCredential();
  if (credential) {
    SCENARIOS[2].headers['x-idemix-credential'] = credential;
    SCENARIOS[3].headers['x-idemix-credential'] = credential;
    console.log('  credential 발급 완료\n');
  } else {
    console.log('  credential 발급 실패 (IDEMIX_ENABLED=false 상태일 수 있음)\n');
  }

  const results = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n[${scenario.name}]`);
    console.log(`  ${scenario.desc}`);
    const r = await runScenario(scenario);
    results.push(r);
    console.log(`  TPS: ${r.tps} req/s   avg: ${r.avgMs}ms   P95: ${r.p95Ms}ms   실패: ${r.failedReqs}`);
  }

  // ── 비교표 출력 ──────────────────────────────────────────────
  console.log('\n\n══════════════════════════════════════════════════════');
  console.log('  최종 비교 결과');
  console.log('══════════════════════════════════════════════════════');

  const header = ['단계', 'TPS', 'avg(ms)', 'P50', 'P95', 'P99', '실패'];
  const colW   = [38, 9, 9, 7, 7, 7, 7];
  const bar    = colW.map(w => '─'.repeat(w)).join('┼');
  const row    = cells => '│' + cells.map((c, i) => String(c).padStart(colW[i])).join('│') + '│';

  console.log('┌' + colW.map(w => '─'.repeat(w)).join('┬') + '┐');
  console.log(row(header));
  console.log('├' + bar + '┤');
  results.forEach(r => {
    const speedup = results[0] ? ` (×${(r.tps / results[0].tps).toFixed(1)})` : '';
    console.log(row([
      r.name.replace('STEP ', 'S').slice(0, 37),
      r.tps + (results.indexOf(r) > 0 ? speedup : ''),
      r.avgMs,
      r.p50Ms,
      r.p95Ms,
      r.p99Ms,
      r.failedReqs,
    ]));
  });
  console.log('└' + colW.map(w => '─'.repeat(w)).join('┴') + '┘');

  if (results.length >= 2) {
    const base   = results[0].avgMs || 1;
    const idemix = results[1].avgMs || 1;
    console.log(`\n  Idemix 오버헤드:  +${(idemix - base).toFixed(1)}ms (+${((idemix - base) / base * 100).toFixed(0)}%)`);
  }
  if (results.length >= 4 && results[2].avgMs && results[3].avgMs) {
    const overhead = results[2].avgMs - results[3].avgMs;
    console.log(`  캐시 효과:        ${overhead.toFixed(1)}ms 감소`);
  }

  // JSON 저장
  const reportsDir = path.join(__dirname, '..', 'benchmark-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const fname = path.join(reportsDir, `idemix-bench-${Date.now()}.json`);
  fs.writeFileSync(fname, JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n  JSON 저장: ${fname}`);
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
