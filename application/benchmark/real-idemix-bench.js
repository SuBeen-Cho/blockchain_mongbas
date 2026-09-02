#!/usr/bin/env node
/**
 * benchmark/real-idemix-bench.js
 * Credential 프로토타입 성능 비교: A(bypass) / B(PS-BN254) / C(BBS+-BLS12381)
 *
 * 측정 지표:
 *   1. Credential 발급 레이턴시 (50회)
 *   2. 인증 레이턴시 분포 (50회 단일스레드)
 *   3. 동시성별 TPS (1/5/10/20 workers, 8초)
 *   4. 스트레스 TPS (20 workers, 15초)
 *   5. 서버 메모리 스냅샷
 *
 * 사용법: node benchmark/real-idemix-bench.js [--url http://localhost:3000] [--out result.json]
 */

'use strict';

const http = require('http');
const {
  isSuccessfulHttpStatus,
  requireHttpSuccess,
  isAcceptedAuth,
  requireExactSuccess,
  requireRequestSeries,
  writeJsonEvidenceExclusive,
} = require('./evidence-contract');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] ?? true;
});

const BASE_URL = args.url || 'http://localhost:3000';
const OUT_FILE = args.out || null;
const STEP_SEC = parseInt(args.sec || '8', 10);

// ── HTTP 헬퍼 ──────────────────────────────────────────────────
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
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

// ── 통계 ──────────────────────────────────────────────────────
function stats(arr) {
  if (!arr.length) return { n: 0, avg: 0, stddev: 0, min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const sorted = arr.slice().sort((a, b) => a - b);
  const n   = sorted.length;
  const avg = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  const p = pct => sorted[Math.max(0, Math.ceil(pct / 100 * n) - 1)];
  return {
    n,
    avg:    +avg.toFixed(2),
    stddev: +(Math.sqrt(variance)).toFixed(2),
    min:    +sorted[0].toFixed(2),
    p50:    +p(50).toFixed(2),
    p90:    +p(90).toFixed(2),
    p95:    +p(95).toFixed(2),
    p99:    +p(99).toFixed(2),
    max:    +sorted[n - 1].toFixed(2),
  };
}

// ── TPS 측정 ──────────────────────────────────────────────────
async function measureTPS(label, url, headers, concurrency, durationMs) {
  const latencies = [];
  let total = 0, successCount = 0, overloadErrorCount = 0, contractErrorCount = 0, finished = false;

  async function worker() {
    while (!finished) {
      const t = process.hrtime.bigint();
      try {
        const u = new URL(url);
        await new Promise(resolve => {
          let settled = false;
          const finish = kind => {
            if (settled) return;
            settled = true;
            total++;
            if (kind === 'success') successCount++;
            else if (kind === 'overload') overloadErrorCount++;
            else contractErrorCount++;
            resolve();
          };
          const req = http.request({
            hostname: u.hostname, port: u.port || 80,
            path: u.pathname, method: 'GET', headers,
          }, res => {
            let buf = '';
            res.on('data', chunk => { buf += chunk; });
            res.on('end', () => {
              const ms = Number(process.hrtime.bigint() - t) / 1e6;
              let body;
              try { body = JSON.parse(buf); } catch { body = null; }
              if (isAcceptedAuth({ status: res.statusCode, body })) {
                latencies.push(ms);
                finish('success');
              } else if (res.statusCode >= 500) finish('overload');
              else finish('contract');
            });
          });
          req.on('error', () => finish('overload'));
          req.setTimeout(10000, () => { req.destroy(); finish('overload'); });
          req.end();
        });
      } catch { total++; overloadErrorCount++; }
    }
  }

  const t0 = Date.now();
  const workers = Array.from({ length: concurrency }, worker);
  await new Promise(r => setTimeout(r, durationMs));
  finished = true;
  await Promise.all(workers);

  const elapsed = (Date.now() - t0) / 1000;
  return {
    label, concurrency,
    durationSec:  +elapsed.toFixed(2),
    total, successCount, overloadErrorCount, contractErrorCount,
    tps:          +(successCount / elapsed).toFixed(1),
    successTps:   +(successCount / elapsed).toFixed(1),
    attemptTps:   +(total / elapsed).toFixed(1),
    errorCount:   overloadErrorCount + contractErrorCount,
    errorRate:    +(((overloadErrorCount + contractErrorCount) / Math.max(total, 1)) * 100).toFixed(2),
    latency:      stats(latencies),
  };
}

// ── 발급 레이턴시 측정 ─────────────────────────────────────────
async function measureIssuance(n = 50, expectedCredType) {
  const latencies = [];
  let sample = null;
  for (let i = 0; i < n; i++) {
    const r = await post(`${BASE_URL}/api/credential/idemix`, {
      enrollmentID: 'voter1', enrollmentSecret: 'voter1pw',
      electionID: `BENCH_ISSUE_${i}`,
    });
    if (isSuccessfulHttpStatus(r.status) && typeof r.body?.credential === 'string' &&
        r.body.credential.length > 0 && r.body.credType === expectedCredType) {
      latencies.push(r.ms);
      if (!sample) sample = r.body;
    }
  }
  return {
    n, successCount: latencies.length, failureCount: n - latencies.length, latency: stats(latencies),
    credType: sample?.credType || 'unknown',
    credSizeBytes: sample ? Buffer.byteLength(sample.credential, 'utf8') : 0,
  };
}

// ── 인증 레이턴시 측정 (단일) ─────────────────────────────────
async function measureAuthLatency(url, headers, n = 50) {
  const latencies = [];
  let errorCount = 0;
  for (let i = 0; i < n; i++) {
    const r = await get(url, headers);
    if (isAcceptedAuth(r)) latencies.push(r.ms);
    else errorCount++;
  }
  return { n, successCount: latencies.length, errorCount, latency: stats(latencies) };
}

// ── 서버 대기 ─────────────────────────────────────────────────
async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await get(`${BASE_URL}/health`);
      if (r.status === 200 && r.body?.status === 'ok' &&
          r.body?.benchmark?.authEndpointEnabled === true &&
          r.body?.benchmark?.rateLimitsDisabled === true &&
          r.body?.benchmark?.demoCredentialsEnabled === true) return r.body;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('서버가 응답하지 않습니다.');
}

// ── 단계별 측정 ───────────────────────────────────────────────
async function runPhase(phaseName, note) {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  [${phaseName}] ${note}`);
  console.log('═'.repeat(65));

  const health = await waitForServer();
  const idemix = health?.idemix || {};
  console.log(`  모드: ${idemix.mode || '?'}  impl: ${idemix.impl || '?'}`);
  console.log(`  메모리: heap ${(health.memory?.heapUsed/1024/1024||0).toFixed(0)}MB`);

  const authURL = `${BASE_URL}/api/bench/auth`;
  const result  = { phase: phaseName, note, idemixInfo: idemix, timestamp: new Date().toISOString() };

  let credential = null;
  const expectedCredType = {
    HMAC: 'HMAC-SHA256', Ed25519: 'Ed25519-asym', B: 'PS-BN254', C: 'BBS+-BLS12381',
  }[phaseName] || null;
  if (idemix.mode !== 'bypass') {
    const cr = requireHttpSuccess(await post(`${BASE_URL}/api/credential/idemix`, {
      enrollmentID: 'voter1', enrollmentSecret: 'voter1pw', electionID: 'BENCH_FIXED',
    }), 'fixed credential issuance');
    if (typeof cr.body?.credential !== 'string' || cr.body.credential.length === 0 ||
        cr.body.credType !== expectedCredType) {
      throw new Error(`fixed credential issuance: expected nonempty ${expectedCredType} credential`);
    }
    credential = cr.body.credential;
  }
  const authHeaders = credential ? { 'x-idemix-credential': credential } : {};

  // ── [1] Credential 발급 레이턴시 ────────────────────────────
  if (idemix.mode !== 'bypass') {
    console.log('\n  [1/4] Credential 발급 레이턴시 (50회 순차)...');
    result.issuance = await measureIssuance(50, expectedCredType);
    requireExactSuccess('credential issuance', result.issuance.n,
      result.issuance.successCount, result.issuance.failureCount);
    const s = result.issuance.latency;
    console.log(`  → avg: ${s.avg}ms  P95: ${s.p95}ms  min: ${s.min}ms  max: ${s.max}ms`);
    console.log(`  → credType: ${result.issuance.credType}  size: ${result.issuance.credSizeBytes}B`);
  } else {
    console.log('\n  [1/4] Credential 발급: bypass 모드 — skip');
    result.issuance = null;
  }

  // ── [2] 자격증명 획득 + 인증 레이턴시 ───────────────────────
  console.log('\n  [2/4] 인증 레이턴시 분포 (50회 순차)...');
  result.authLatency = await measureAuthLatency(authURL, authHeaders, 50);
  requireExactSuccess('sequential authentication', result.authLatency.n,
    result.authLatency.successCount, result.authLatency.errorCount);
  const s = result.authLatency.latency;
  console.log(`  → avg: ${s.avg}ms  P50: ${s.p50}ms  P95: ${s.p95}ms  P99: ${s.p99}ms`);

  // ── [3] 동시성별 TPS ─────────────────────────────────────────
  console.log('\n  [3/4] 동시성별 TPS (1→5→10→20 workers, 각 ' + STEP_SEC + '초)...');
  result.concurrencyTPS = [];
  for (const c of [1, 5, 10, 20]) {
    process.stdout.write(`  workers=${c}... `);
    const r = await measureTPS(`${phaseName}-c${c}`, authURL, authHeaders, c, STEP_SEC * 1000);
    requireRequestSeries(`${phaseName} concurrency ${c}`, r);
    result.concurrencyTPS.push(r);
    console.log(`TPS=${r.tps}  avg=${r.latency.avg}ms  P99=${r.latency.p99}ms  err=${r.errorCount}`);
  }

  // ── [4] 스트레스 테스트 ──────────────────────────────────────
  console.log('\n  [4/4] 스트레스 테스트 (20 workers × 15초)...');
  result.stressTest = await measureTPS(`${phaseName}-stress`, authURL, authHeaders, 20, 15000);
  requireRequestSeries(`${phaseName} stress`, result.stressTest);
  const st = result.stressTest;
  console.log(`  → TPS=${st.tps}  avg=${st.latency.avg}ms  P99=${st.latency.p99}ms  에러율=${st.errorRate}%`);

  // 메모리 최종 스냅샷
  const mem = await get(`${BASE_URL}/health`);
  result.memoryAfter = mem.body?.memory || null;

  result.evidenceValid = true;

  return result;
}

// ── 종합 비교 출력 ────────────────────────────────────────────
function printSummary(phases) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  Credential 프로토타입 A/B/C 비교 요약');
  console.log('═'.repeat(70));

  const labels = {
    'A': '기준선(bypass)',
    'B': 'PS-BN254 credential prototype',
    'C': 'BBS+-BLS12381 (개선 Idemix)',
  };

  // 인증 레이턴시 비교
  console.log('\n  인증 레이턴시 (단일 스레드 avg):');
  for (const p of phases) {
    const avg = p.authLatency?.latency?.avg ?? 0;
    const a   = phases.find(x => x.phase === 'A')?.authLatency?.latency?.avg ?? 1;
    const overhead = avg - a;
    const bar = '█'.repeat(Math.min(40, Math.round(avg / 3)));
    console.log(`  ${p.phase} [${labels[p.phase] || p.phase}]`);
    console.log(`    avg=${avg}ms  P95=${p.authLatency?.latency?.p95 ?? 0}ms  overhead=+${overhead.toFixed(1)}ms`);
    console.log(`    ${bar}`);
  }

  // TPS 비교 (20 workers)
  console.log('\n  TPS @ 20 workers:');
  for (const p of phases) {
    const tps = p.concurrencyTPS?.find(r => r.concurrency === 20)?.tps ?? 0;
    const bar = '█'.repeat(Math.min(40, Math.round(tps / 50)));
    console.log(`  ${p.phase} [${labels[p.phase] || p.phase}]  TPS=${tps}  ${bar}`);
  }

  // 발급 레이턴시 비교
  console.log('\n  Credential 발급 avg:');
  for (const p of phases) {
    const avg = p.issuance?.latency?.avg ?? 0;
    const sz  = p.issuance?.credSizeBytes ?? 0;
    const t   = p.issuance?.credType ?? 'bypass';
    console.log(`  ${p.phase} [${labels[p.phase] || p.phase}]  avg=${avg}ms  size=${sz}B  type=${t}`);
  }

  // B → C 개선 요약
  const A = phases.find(p => p.phase === 'A');
  const B = phases.find(p => p.phase === 'B');
  const C = phases.find(p => p.phase === 'C');
  if (B && C) {
    const bAuth  = B.authLatency?.latency?.avg ?? 1;
    const cAuth  = C.authLatency?.latency?.avg ?? 1;
    const bIssue = B.issuance?.latency?.avg ?? 1;
    const cIssue = C.issuance?.latency?.avg ?? 1;
    const bTps   = B.stressTest?.tps ?? 1;
    const cTps   = C.stressTest?.tps ?? 1;
    console.log('\n  B→C 개선 지표:');
    console.log(`  인증 레이턴시: ${bAuth}ms → ${cAuth}ms  (${(bAuth/cAuth).toFixed(2)}x 향상)`);
    console.log(`  발급 레이턴시: ${bIssue}ms → ${cIssue}ms  (${(bIssue/cIssue).toFixed(2)}x 향상)`);
    console.log(`  스트레스 TPS:  ${bTps} → ${cTps}  (${(cTps/bTps).toFixed(2)}x 향상)`);
    console.log('  보안 속성(비연결성/선택적 공개)은 이 성능 벤치마크로 입증하지 않음');
  }
  console.log('═'.repeat(70));
}

// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  const health = await waitForServer();
  const idemix = health?.idemix || {};

  // 현재 단계 감지
  let phaseName, note;
  const impl = idemix.idemixImpl || '';
  if (!idemix.enabled) {
    phaseName = 'A'; note = 'bypass (인증 없음 — 성능 기준선)';
  } else if (impl === 'ps') {
    phaseName = 'B'; note = 'PS-BN254 credential prototype (Fabric Idemix 호환성 미주장)';
  } else if (impl === 'bbs') {
    phaseName = 'C'; note = 'BBS+-BLS12381 credential prototype (현재 구현 실측)';
  } else if (idemix.asymEnabled) {
    phaseName = 'Ed25519'; note = 'Ed25519 공개키 credential (체인코드 직접 검증 기준선)';
  } else {
    phaseName = 'HMAC'; note = 'HMAC-SHA256 credential (대칭키 개발 기준)';
  }

  const phaseResult = await runPhase(phaseName, note);
  printSummary([phaseResult]);

  if (OUT_FILE) {
    writeJsonEvidenceExclusive(OUT_FILE, phaseResult);
    console.log(`\n  결과 저장: ${OUT_FILE}`);
  }
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
