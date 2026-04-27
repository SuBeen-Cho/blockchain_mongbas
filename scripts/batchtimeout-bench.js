#!/usr/bin/env node
/**
 * scripts/batchtimeout-bench.js — BatchTimeout별 TPS/Latency 측정
 *
 * 측정 항목:
 *   - BatchTimeout: 500ms / 1s / 2s(기본) / 5s
 *   - 각 BT에서 TPS 목표: 1 / 5 / 10 / 20
 *   - 측정: 실제 달성 TPS, avg / P50 / P95 / P99 latency, 실패율
 *
 * 실행 방법:
 *   cd mongbas
 *   # 각 BatchTimeout 값에 대해 순서대로 실행:
 *   bash scripts/update-batchtimeout.sh 500ms && sleep 3 && node scripts/batchtimeout-bench.js 500ms
 *   bash scripts/update-batchtimeout.sh 1s    && sleep 3 && node scripts/batchtimeout-bench.js 1s
 *   bash scripts/update-batchtimeout.sh 2s    && sleep 3 && node scripts/batchtimeout-bench.js 2s
 *   bash scripts/update-batchtimeout.sh 5s    && sleep 3 && node scripts/batchtimeout-bench.js 5s
 *
 *   # 또는 전체 자동 실행 (네트워크 실행 중이어야 함):
 *   bash scripts/run-batchtimeout-all.sh
 *
 * 출력: docs/security-eval/extended/bt-results/<timeout>.json
 *       docs/security-eval/extended/BATCHTIMEOUT-RESULTS.md (전체 결과 합산 후)
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const TIMEOUT_LABEL = process.argv[2] || '2s';
const BASE    = 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '../docs/security-eval/extended/bt-results');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── HTTP 헬퍼 ────────────────────────────────────────────────────
function req(method, urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost', port: 3000,
      path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)];
}

function stats(arr) {
  if (!arr.length) return { n: 0, avg: '0', stddev: '0', min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  const s = arr.slice().sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / s.length;
  return {
    n:      s.length,
    avg:    avg.toFixed(1),
    stddev: Math.sqrt(variance).toFixed(1),
    min:    s[0],
    max:    s[s.length - 1],
    p50:    percentile(s, 50),
    p95:    percentile(s, 95),
    p99:    percentile(s, 99),
  };
}

// ── 선거 생성 헬퍼 ───────────────────────────────────────────────
async function createActiveElection(suffix) {
  const eid = `bt-bench-${suffix}-${Date.now()}`;
  await req('POST', '/api/elections', {
    electionID:  eid,
    title:       `BT 벤치마크 ${suffix}`,
    description: 'BatchTimeout 벤치마크용',
    candidates:  ['A', 'B', 'C'],
    startTime:   Math.floor(Date.now() / 1000),
    endTime:     Math.floor(Date.now() / 1000) + 7200,
  });
  await req('POST', `/api/elections/${eid}/activate`);
  return eid;
}

// ── 단일 TPS 레벨 측정 ───────────────────────────────────────────
async function measureAtTps(targetTps, txCount, batchTimeout) {
  const eid = await createActiveElection(`bt${batchTimeout}-tps${targetTps}`);
  const intervalMs = 1000 / targetTps;

  const latencies  = [];
  const results    = [];
  const startTotal = Date.now();

  for (let i = 0; i < txCount; i++) {
    const secret = `voter-${batchTimeout}-${targetTps}-${i}-${Date.now()}`;
    const nh = sha256(secret + eid);

    const t0 = Date.now();
    let ok = false;
    try {
      const r = await req('POST', '/api/vote', {
        electionID:   eid,
        candidateID:  i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C',
        nullifierHash: nh,
        voterID:      `voter-${i}`,
      }, 20000);
      ok = r.status === 200;
    } catch {}

    const elapsed = Date.now() - t0;
    results.push(ok);
    if (ok) latencies.push(elapsed);

    // TPS 제어: 다음 트랜잭션까지 대기
    const waited = Date.now() - t0;
    if (waited < intervalMs) await sleep(intervalMs - waited);

    process.stdout.write(`\r  TPS ${targetTps} 진행: ${i + 1}/${txCount} (성공: ${results.filter(Boolean).length})`);
  }

  const totalElapsed = (Date.now() - startTotal) / 1000;
  const successCount = results.filter(Boolean).length;
  const actualTps = (successCount / totalElapsed).toFixed(2);
  console.log();

  return {
    targetTps,
    txCount,
    success:    successCount,
    fail:       txCount - successCount,
    failRate:   ((txCount - successCount) / txCount * 100).toFixed(1) + '%',
    actualTps,
    totalElapsedSec: totalElapsed.toFixed(1),
    latency: stats(latencies),
  };
}

// ── 메인 ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== BatchTimeout ${TIMEOUT_LABEL} 벤치마크 시작 ===`);

  // TPS 레벨 설정
  // BatchTimeout이 클수록 저TPS 구간에서 레이턴시가 크게 달라짐
  const TPS_LEVELS = [
    { tps: 1,  txCount: 30  },   // BT 지배 구간
    { tps: 3,  txCount: 60  },   // BT 영향 구간
    { tps: 5,  txCount: 100 },   // BT/MaxMsg 경계 구간
    { tps: 10, txCount: 150 },   // MaxMsg 지배 구간
    { tps: 20, txCount: 200 },   // 고부하 구간
  ];

  const roundResults = [];

  for (const { tps, txCount } of TPS_LEVELS) {
    console.log(`\n[TPS ${tps}] ${txCount}tx 측정 중...`);
    try {
      const r = await measureAtTps(tps, txCount, TIMEOUT_LABEL);
      roundResults.push(r);
      console.log(`  ✅ 실제 TPS: ${r.actualTps}, avg: ${r.latency.avg}ms, P95: ${r.latency.p95}ms, 실패율: ${r.failRate}`);
    } catch (e) {
      console.error(`  ❌ 실패: ${e.message}`);
      roundResults.push({ targetTps: tps, error: e.message });
    }
    // 다음 라운드 전 2초 쿨다운
    await sleep(2000);
  }

  const output = {
    batchTimeout: TIMEOUT_LABEL,
    runDate:      new Date().toLocaleString('ko-KR'),
    rounds:       roundResults,
  };

  const outPath = path.join(OUT_DIR, `${TIMEOUT_LABEL}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ 결과 저장: ${outPath}`);
  console.log('=== 완료 ===\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
