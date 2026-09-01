#!/usr/bin/env node
/**
 * benchmark/elgamal-e2e-bench.js
 * ElGamal 기반 E2E 투표 성능 벤치마크
 *
 * 측정 시나리오:
 *   S1: ElGamal + Ed25519 (기준선)
 *   S2: ElGamal + PS-BN254
 *   S3: ElGamal + BBS+
 *
 * 측정 항목:
 *   - E2E 투표 확정 시간 (암호화 + ZKP 생성 + 서버 제출 + 블록 확정)
 *   - 클라이언트 측 ElGamal 암호화 시간
 *   - 클라이언트 측 ZKP 생성 시간
 *   - 자격증명 발급 시간
 *   - 서버 측 투표 처리 시간 (= E2E - 클라이언트 암호화 - ZKP)
 *   - 집계(TallyVotes) 시간
 *
 * 사용법:
 *   node benchmark/elgamal-e2e-bench.js [--url http://localhost:3000] [--n 100] [--warmup 10] [--out results.json]
 *
 * 환경변수:
 *   서버는 원하는 IDEMIX_IMPL (ed25519 / ps / bbs) 로 기동되어 있어야 함
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ── CLI 인자 ────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] ?? true;
});

const BASE = args.url || 'http://localhost:3000';
const N = parseInt(args.n || '100', 10);
const WARMUP = parseInt(args.warmup || '10', 10);
const CANDIDATES = ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'];
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const OUT = args.out || path.join(__dirname, `../benchmark-reports/elgamal-e2e-${TIMESTAMP}.json`);

// ── HTTP 헬퍼 ───────────────────────────────────────────────────
function rawRequest(method, urlPath, body = null, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const start = process.hrtime.bigint();
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        let parsed = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, ms });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p, h = {}) => rawRequest('GET', p, null, h);
const post = (p, b, h = {}, t) => rawRequest('POST', p, b, h, t);

// ── 통계 ────────────────────────────────────────────────────────
function stats(values) {
  if (!values.length) return { n: 0, avg: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, stddev: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  const p = pct => sorted[Math.max(0, Math.ceil((pct / 100) * n) - 1)];
  return {
    n,
    avg: +avg.toFixed(2),
    stddev: +Math.sqrt(variance).toFixed(2),
    min: +sorted[0].toFixed(2),
    p50: +p(50).toFixed(2),
    p95: +p(95).toFixed(2),
    p99: +p(99).toFixed(2),
    max: +sorted[n - 1].toFixed(2),
  };
}

// ── SHA-256 ─────────────────────────────────────────────────────
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── BigInt 유틸 ─────────────────────────────────────────────────
function modPow(base, exp, mod) {
  base = ((base % mod) + mod) % mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a, m) {
  a = ((a % m) + m) % m;
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) return null;
  return ((old_s % m) + m) % m;
}

function randomBigInt(bytes) {
  const buf = crypto.randomBytes(bytes);
  let result = 0n;
  for (const b of buf) result = (result << 8n) | BigInt(b);
  return result;
}

// ── ElGamal 암호화 ──────────────────────────────────────────────
const HOMOMORPHIC_BASE = 10000n;

function elgamalEncrypt(pubKey, candidateIndex) {
  const p = BigInt('0x' + pubKey.p);
  const g = BigInt('0x' + pubKey.g);
  const y = BigInt('0x' + pubKey.y);

  const m = HOMOMORPHIC_BASE ** BigInt(candidateIndex);
  const gm = modPow(g, m, p);

  let r = randomBigInt(32) % (p - 2n);
  if (r === 0n) r = 1n;

  const c1 = modPow(g, r, p);
  const yr = modPow(y, r, p);
  const c2 = (gm * yr) % p;

  return { c1: c1.toString(16), c2: c2.toString(16), _r: r };
}

// ── Disjunctive Chaum-Pedersen ZKP 생성 ─────────────────────────
function generateBallotValidityProof(pubKey, c1Hex, c2Hex, r, actualIndex, numCandidates) {
  const p = BigInt('0x' + pubKey.p);
  const g = BigInt('0x' + pubKey.g);
  const y = BigInt('0x' + pubKey.y);
  const q = (p - 1n) / 2n;
  const c1 = BigInt('0x' + c1Hex);
  const c2 = BigInt('0x' + c2Hex);

  const a1s = new Array(numCandidates);
  const a2s = new Array(numCandidates);
  const es = new Array(numCandidates);
  const zs = new Array(numCandidates);

  let k = randomBigInt(32) % q;
  if (k === 0n) k = 1n;

  let eSum = 0n;
  for (let j = 0; j < numCandidates; j++) {
    if (j === actualIndex) continue;

    const mj = modPow(g, HOMOMORPHIC_BASE ** BigInt(j), p);
    const mjInv = modInverse(mj, p);
    const c2DivMj = (c2 * mjInv) % p;

    const ej = randomBigInt(32) % q;
    const zj = randomBigInt(32) % q;

    const gzj = modPow(g, zj, p);
    const c1InvEj = modPow(modInverse(c1, p), ej, p);
    a1s[j] = ((gzj * c1InvEj) % p).toString(16);

    const yzj = modPow(y, zj, p);
    const c2DivMjInvEj = modPow(modInverse(c2DivMj, p), ej, p);
    a2s[j] = ((yzj * c2DivMjInvEj) % p).toString(16);

    es[j] = ej.toString(16);
    zs[j] = zj.toString(16);
    eSum = (eSum + ej) % q;
  }

  a1s[actualIndex] = modPow(g, k, p).toString(16);
  a2s[actualIndex] = modPow(y, k, p).toString(16);

  // Fiat-Shamir challenge
  let hashInput = c1Hex + '|' + c2Hex;
  for (let j = 0; j < numCandidates; j++) {
    hashInput += '|' + a1s[j] + '|' + a2s[j];
  }
  const eTotal = BigInt('0x' + sha256Hex(hashInput)) % q;

  const eActual = ((eTotal - eSum) % q + q) % q;
  es[actualIndex] = eActual.toString(16);
  const zActual = (k + eActual * r) % q;
  zs[actualIndex] = zActual.toString(16);

  return { a1s, a2s, es, zs };
}

// ── 자격증명 발급 ───────────────────────────────────────────────
async function issueCredential(electionID) {
  const t0 = process.hrtime.bigint();
  const res = await post('/api/credential/idemix', {
    enrollmentID: 'voter1',
    enrollmentSecret: 'voter1pw',
    electionID,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.status !== 200 || !res.body?.credential) {
    throw new Error(`credential failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    credential: res.body.credential,
    credType: res.body.credType,
    sizeBytes: Buffer.byteLength(res.body.credential, 'utf8'),
    latencyMs: +ms.toFixed(2),
  };
}

// ── 선거 생성 (ElGamal 모드 고정) ───────────────────────────────
async function createElGamalElection(label) {
  const electionID = `elgamal-bench-${label}-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const create = await post('/api/elections', {
    electionID,
    title: `ElGamal Bench ${label}`,
    description: 'ElGamal E2E benchmark',
    candidates: CANDIDATES,
    startTime: now,
    endTime: now + 7200,
    encryptionMode: 'elgamal',
  });
  if (create.status >= 400) throw new Error(`create failed: ${create.status} ${JSON.stringify(create.body)}`);

  const activate = await post(`/api/elections/${electionID}/activate`, {});
  if (activate.status >= 400) throw new Error(`activate failed: ${activate.status} ${JSON.stringify(activate.body)}`);

  // ElGamal 공개키 조회
  const pubKeyRes = await get(`/api/elections/${electionID}/elgamal-pubkey`);
  if (pubKeyRes.status >= 400) throw new Error(`pubkey failed: ${pubKeyRes.status}`);

  const pubKey = pubKeyRes.body.pubKey || pubKeyRes.body;
  return { electionID, pubKey };
}

// ── 단일 투표 E2E 측정 ──────────────────────────────────────────
async function measureSingleVote(electionID, pubKey, candidateIdx, authHeaders, voteIndex) {
  const timings = {};

  // 1. Nullifier 생성
  const nullifierHash = sha256Hex(`elgamal-bench-${voteIndex}-${Date.now()}-${electionID}`);

  // 2. ElGamal 암호화
  const t_enc_start = process.hrtime.bigint();
  const encrypted = elgamalEncrypt(pubKey, candidateIdx);
  timings.clientEncryptMs = Number(process.hrtime.bigint() - t_enc_start) / 1e6;

  // 3. ZKP 생성
  const t_zkp_start = process.hrtime.bigint();
  const proof = generateBallotValidityProof(
    pubKey, encrypted.c1, encrypted.c2, encrypted._r,
    candidateIdx, CANDIDATES.length
  );
  timings.clientZkpMs = Number(process.hrtime.bigint() - t_zkp_start) / 1e6;

  // 4. 페이로드 구성
  const voteBody = {
    electionID,
    nullifierHash,
    encryptedCandidateID: encrypted.c1 + ':' + encrypted.c2,
    voterID: `bench-voter-${voteIndex}`,
    ballotValidityProof: JSON.stringify(proof),
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(voteBody), 'utf8');

  // 5. 서버 제출 (투표 확정 시간 = 서버 처리 + 블록 확정)
  const t_submit_start = process.hrtime.bigint();
  const res = await post('/api/vote', voteBody, authHeaders, 60000);
  timings.serverConfirmMs = Number(process.hrtime.bigint() - t_submit_start) / 1e6;

  // 6. E2E 전체 시간
  timings.e2eTotalMs = timings.clientEncryptMs + timings.clientZkpMs + timings.serverConfirmMs;

  return {
    success: res.status >= 200 && res.status < 300,
    candidateIndex: candidateIdx,
    status: res.status,
    timings,
    payloadBytes,
    error: res.status >= 400 ? (res.body?.error || res.body?.reason || 'error') : null,
  };
}

// ── 집계(Tally) 측정 ────────────────────────────────────────────
async function measureTally(electionID, expectedResults) {
  // 선거 종료
  const closeRes = await post(`/api/elections/${electionID}/close`, {}, {}, 120000);
  if (closeRes.status >= 400) {
    return { success: false, error: `close failed: ${closeRes.status}`, tallyMs: 0 };
  }

  const partials = [];
  for (const shareIndex of ['1', '2']) {
    const partial = await post(`/api/elections/${electionID}/partial-decryptions`, { shareIndex }, {}, 120000);
    partials.push(partial);
    if (partial.status >= 400) {
      return { success: false, error: `partial ${shareIndex} failed: ${partial.status}`, closeMs: closeRes.ms, partialMs: partials.reduce((sum, item) => sum + item.ms, 0) };
    }
  }

  // 집계 결과 조회
  const tallyRes = await get(`/api/elections/${electionID}/tally`);
  const results = tallyRes.body?.results || {};
  const exact = tallyRes.status < 400 && tallyRes.body?.decrypted === true &&
    tallyRes.body?.partialDecryptions?.length === 2 &&
    CANDIDATES.every((candidate) => results[candidate] === expectedResults[candidate]);

  return {
    success: exact,
    error: exact ? null : `exact threshold tally mismatch: ${JSON.stringify(tallyRes.body)}`,
    closeMs: +closeRes.ms.toFixed(2),
    partialMs: +partials.reduce((sum, item) => sum + item.ms, 0).toFixed(2),
    tallyMs: +(closeRes.ms + partials.reduce((sum, item) => sum + item.ms, 0) + tallyRes.ms).toFixed(2),
    results: tallyRes.body,
  };
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log(' ElGamal E2E Benchmark');
  console.log('═══════════════════════════════════════════════════');

  // Health check
  const health = await get('/health');
  if (health.status !== 200) throw new Error('API server not ready');
  const idemix = health.body.idemix || {};

  const label = !idemix.enabled
    ? 'A-bypass'
    : idemix.idemixImpl === 'ps'
      ? 'S2-PS-BN254'
      : idemix.idemixImpl === 'bbs'
        ? 'S3-BBS'
        : idemix.asymEnabled
          ? 'S1-Ed25519'
          : 'S1-HMAC';

  console.log(`[INFO] 시나리오: ${label}`);
  console.log(`[INFO] N=${N}, warmup=${WARMUP}, url=${BASE}`);
  console.log(`[INFO] idemix: enabled=${idemix.enabled} impl=${idemix.idemixImpl || idemix.impl}`);

  // 1. 선거 생성 (ElGamal 모드)
  console.log('\n[1/5] 선거 생성 (ElGamal 모드)...');
  const { electionID, pubKey } = await createElGamalElection(label);
  console.log(`  electionID: ${electionID}`);
  console.log(`  pubKey.p length: ${pubKey.p?.length || 0} hex chars`);

  // 2. 자격증명 발급
  console.log('\n[2/5] 자격증명 발급...');
  const credentialSamples = [];
  let authHeaders = {};
  if (idemix.enabled) {
    for (let i = 0; i < 5; i++) {
      const cred = await issueCredential(electionID);
      credentialSamples.push(cred);
      if (i === 0) authHeaders = { 'x-idemix-credential': cred.credential };
    }
    console.log(`  credType: ${credentialSamples[0].credType}`);
    console.log(`  avg latency: ${(credentialSamples.reduce((s, c) => s + c.latencyMs, 0) / credentialSamples.length).toFixed(1)}ms`);
  } else {
    console.log('  (인증 bypass 모드)');
  }

  // 3. Warmup
  console.log(`\n[3/5] Warmup (${WARMUP}회)...`);
  for (let i = 0; i < WARMUP; i++) {
    const warmupResult = await measureSingleVote(electionID, pubKey, i % CANDIDATES.length, authHeaders, `warmup-${i}`);
    if (!warmupResult.success) throw new Error(`warmup vote ${i} failed: HTTP ${warmupResult.status} ${warmupResult.error}`);
    process.stdout.write(`\r  warmup: ${i + 1}/${WARMUP}`);
  }
  console.log(' done');

  // 4. 본 측정
  console.log(`\n[4/5] 본 측정 (${N}회)...`);
  const results = [];
  let successCount = 0;
  const errors = {};

  for (let i = 0; i < N; i++) {
    // 자격증명 갱신 (매 20회)
    if (idemix.enabled && i > 0 && i % 20 === 0) {
      try {
        const cred = await issueCredential(electionID);
        authHeaders = { 'x-idemix-credential': cred.credential };
        credentialSamples.push(cred);
      } catch (e) {
        console.warn(`\n  [WARN] credential renewal failed at i=${i}: ${e.message}`);
      }
    }

    try {
      const r = await measureSingleVote(electionID, pubKey, i % CANDIDATES.length, authHeaders, i);
      results.push(r);
      if (r.success) successCount++;
      else {
        const key = `${r.status}:${r.error}`.slice(0, 100);
        errors[key] = (errors[key] || 0) + 1;
      }
    } catch (e) {
      const key = `exception:${e.message}`.slice(0, 100);
      errors[key] = (errors[key] || 0) + 1;
      results.push({ success: false, error: e.message, timings: {} });
    }
    process.stdout.write(`\r  vote: ${i + 1}/${N} success=${successCount}`);
  }
  console.log('');

  // 5. 집계 측정
  console.log('\n[5/5] 집계(TallyVotes) 측정...');
  const expectedResults = Object.fromEntries(CANDIDATES.map((candidate) => [candidate, 0]));
  for (let i = 0; i < WARMUP; i++) expectedResults[CANDIDATES[i % CANDIDATES.length]]++;
  for (const result of results) {
    if (result.success) expectedResults[CANDIDATES[result.candidateIndex]]++;
  }
  const tally = await measureTally(electionID, expectedResults);
  console.log(`  tally: ${tally.success ? 'OK' : 'FAIL'} latency=${tally.tallyMs}ms`);
  if (!tally.success) throw new Error(tally.error || 'threshold tally failed');

  // ── 결과 집계 ─────────────────────────────────────────────────
  const successful = results.filter(r => r.success);

  const report = {
    scenario: label,
    timestamp: new Date().toISOString(),
    config: {
      N, WARMUP, candidates: CANDIDATES.length,
      encryptionMode: 'elgamal',
      idemix,
      url: BASE,
    },
    summary: {
      total: N,
      success: successCount,
      fail: N - successCount,
      failRate: +(((N - successCount) / N) * 100).toFixed(2),
    },
    e2eTotal: stats(successful.map(r => r.timings.e2eTotalMs)),
    clientEncrypt: stats(successful.map(r => r.timings.clientEncryptMs)),
    clientZkp: stats(successful.map(r => r.timings.clientZkpMs)),
    serverConfirm: stats(successful.map(r => r.timings.serverConfirmMs)),
    serverOnly: stats(successful.map(r =>
      r.timings.serverConfirmMs // 서버 측 = 체인코드 ZKP 검증 + endorsement + ordering + commit
    )),
    payloadBytes: stats(successful.map(r => r.payloadBytes)),
    credential: {
      samples: credentialSamples.length,
      latency: stats(credentialSamples.map(c => c.latencyMs)),
      sizeBytes: credentialSamples.length > 0 ? credentialSamples[0].sizeBytes : 0,
      credType: credentialSamples.length > 0 ? credentialSamples[0].credType : 'none',
    },
    tally: {
      success: tally.success,
      closeMs: tally.closeMs,
      partialDecryptionMs: tally.partialMs,
      latencyMs: tally.tallyMs,
      expectedResults,
      results: tally.results,
    },
    errors,
  };

  // ── 결과 출력 ─────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(` 결과 요약: ${label}`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`  성공률: ${successCount}/${N} (${report.summary.failRate}% fail)`);
  console.log('');
  console.log('  [E2E 전체]');
  console.log(`    avg: ${report.e2eTotal.avg}ms  P50: ${report.e2eTotal.p50}ms  P95: ${report.e2eTotal.p95}ms`);
  console.log('  [클라이언트 ElGamal 암호화]');
  console.log(`    avg: ${report.clientEncrypt.avg}ms  P50: ${report.clientEncrypt.p50}ms`);
  console.log('  [클라이언트 ZKP 생성]');
  console.log(`    avg: ${report.clientZkp.avg}ms  P50: ${report.clientZkp.p50}ms`);
  console.log('  [서버 확정 (ZKP 검증 + endorsement + commit)]');
  console.log(`    avg: ${report.serverConfirm.avg}ms  P50: ${report.serverConfirm.p50}ms  P95: ${report.serverConfirm.p95}ms`);
  console.log(`  [페이로드]`);
  console.log(`    avg: ${report.payloadBytes.avg} bytes`);
  if (credentialSamples.length > 0) {
    console.log(`  [자격증명: ${report.credential.credType}]`);
    console.log(`    발급 avg: ${report.credential.latency.avg}ms  size: ${report.credential.sizeBytes} bytes`);
  }
  console.log(`  [집계] ${tally.tallyMs}ms`);
  if (Object.keys(errors).length > 0) {
    console.log('  [에러]');
    for (const [k, v] of Object.entries(errors)) console.log(`    ${k}: ${v}`);
  }

  // ── 파일 저장 ─────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n결과 저장: ${OUT}`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
