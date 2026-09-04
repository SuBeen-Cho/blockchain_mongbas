#!/usr/bin/env node
/**
 * benchmark/elgamal-concurrency-bench.js
 * ElGamal 모드 동시성(확장성) 벤치마크
 *
 * 측정: 동시 투표자 수별 TPS, 레이턴시, 에러율 (ElGamal + ZKP 포함)
 *
 * 사용법:
 *   node benchmark/elgamal-concurrency-bench.js \
 *     [--url http://localhost:3000] \
 *     [--conc 1,10,50,100,300,500,1000] \
 *     [--stopFailRate 30] \
 *     [--out results.json]
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { generateVectorBallot } = require('../src/lib/vectorElgamal');
const { writeJsonEvidenceExclusive } = require('./evidence-contract');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] ?? true;
});

const BASE = args.url || 'http://localhost:3000';
const CONCURRENCIES = (args.conc || '1,10,50,100,300,500,1000').split(',').map(Number).filter(Boolean);
const STOP_FAIL_RATE = Number(args.stopFailRate || 30);
const CANDIDATES = ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'];
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const OUT = args.out || path.join(__dirname, `../benchmark-reports/elgamal-conc-${TIMESTAMP}.json`);
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

// ── HTTP 헬퍼 ───────────────────────────────────────────────────
function rawRequest(method, urlPath, body = null, headers = {}, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const start = process.hrtime.bigint();
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      // Node 22 globalAgent의 오래된 keep-alive socket 재사용을 배제하고
      // 독립된 원격 투표자가 각각 연결하는 부하를 모사한다.
      agent: false,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(ADMIN_API_TOKEN ? { Authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
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
    req.on('error', err => resolve({ status: 0, body: { error: err.message }, ms: Number(process.hrtime.bigint() - start) / 1e6 }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p, h = {}) => rawRequest('GET', p, null, h);
const post = (p, b, h = {}, t) => rawRequest('POST', p, b, h, t);

function sha256Hex(input) { return crypto.createHash('sha256').update(input).digest('hex'); }

function stats(values) {
  if (!values.length) return { n: 0, avg: 0, stddev: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const p = pct => sorted[Math.max(0, Math.ceil((pct / 100) * n) - 1)];
  return {
    n,
    avg: +mean.toFixed(1),
    stddev: +Math.sqrt(variance).toFixed(2),
    min: +sorted[0].toFixed(1),
    p50: +p(50).toFixed(1),
    p95: +p(95).toFixed(1),
    p99: +p(99).toFixed(1),
    max: +sorted[n - 1].toFixed(1),
  };
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

// ── ElGamal + ZKP ───────────────────────────────────────────────
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

  let hashInput = c1Hex + '|' + c2Hex;
  for (let j = 0; j < numCandidates; j++) hashInput += '|' + a1s[j] + '|' + a2s[j];
  const eTotal = BigInt('0x' + sha256Hex(hashInput)) % q;

  const eActual = ((eTotal - eSum) % q + q) % q;
  es[actualIndex] = eActual.toString(16);
  const zActual = (k + eActual * r) % q;
  zs[actualIndex] = zActual.toString(16);

  return { a1s, a2s, es, zs };
}

// ── 선거 생성 (ElGamal) ─────────────────────────────────────────
async function createElection(label) {
  const electionID = `elgamal-conc-${label}-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const create = await post('/api/elections', {
    electionID,
    title: `ElGamal Concurrency ${label}`,
    description: 'ElGamal concurrency benchmark',
    candidates: CANDIDATES,
    startTime: now,
    endTime: now + 7200,
    encryptionMode: 'elgamal-vector-v3',
  }, {}, 60000);
  if (create.status >= 400) throw new Error(`create failed: ${create.status} ${JSON.stringify(create.body)}`);

  const activate = await post(`/api/elections/${electionID}/activate`, {}, {}, 60000);
  if (activate.status >= 400) throw new Error(`activate failed: ${activate.status}`);

  const pubKeyRes = await get(`/api/elections/${electionID}/elgamal-pubkey`);
  if (pubKeyRes.status >= 400) throw new Error(`pubkey failed: ${pubKeyRes.status}`);
  const pubKey = pubKeyRes.body.pubKey || pubKeyRes.body;

  const bfRes = await get(`/api/elections/${electionID}/blinding-factor`);
  if (bfRes.status >= 400 || !bfRes.body?.blindingFactor) throw new Error(`blinding factor failed: ${bfRes.status}`);
  return { electionID, pubKey, blindingFactor: bfRes.body.blindingFactor };
}

async function issueCredential(electionID, voterNumber) {
  const enrollmentID = `demo${String(voterNumber).padStart(3, '0')}`;
  const res = await post('/api/credential/idemix', {
    enrollmentID,
    enrollmentSecret: `${enrollmentID}pw`,
    electionID,
  }, {}, 30000);
  if (res.status !== 200 || !res.body?.credential || !res.body?.nullifierMaterial) {
    throw new Error(`credential failed: ${res.status}`);
  }
  return { credential: res.body.credential, nullifierMaterial: res.body.nullifierMaterial };
}

// ── 단일 투표 (ElGamal + ZKP) ───────────────────────────────────
function prepareVote(electionID, pubKey, blindingFactor, i, credential) {
  const candidateIdx = i % CANDIDATES.length;
  const nullifierHash = sha256Hex(credential.nullifierMaterial + electionID + blindingFactor);
  const ballot = generateVectorBallot(pubKey, candidateIdx, CANDIDATES.length);
  const clientNonce = crypto.randomBytes(32).toString('hex');
  const clientNonceHash = sha256Hex(clientNonce);
  return {
    headers: credential.credential ? { 'x-idemix-credential': credential.credential } : {},
    index: i,
    prepareBody: {
      electionID,
      nullifierHash,
      clientNonceHash,
      encryptedCandidateVector: ballot.encryptedCandidateVector,
      vectorBallotValidityProof: ballot.vectorBallotValidityProof,
    },
    castBody: {
      electionID,
      nullifierHash,
      encryptedCandidateVector: ballot.encryptedCandidateVector,
      vectorBallotValidityProof: ballot.vectorBallotValidityProof,
    },
  };
}

async function castPreparedVote(prepared, index = prepared.index) {
  const started = process.hrtime.bigint();
  const committed = await post('/api/vote/prepare-vector', prepared.prepareBody, prepared.headers, 180000);
  if (committed.status < 200 || committed.status >= 300 || !committed.body?.ballotID) {
    return { index, ok: false, status: committed.status, ms: Number(process.hrtime.bigint() - started) / 1e6,
      prepareCommitted: false, castAttempted: false, castCommitted: false,
      error: committed.body?.error || 'prepare-vector failed' };
  }
  const cast = await post('/api/vote/cast-vector', { ...prepared.castBody, ballotID: committed.body.ballotID }, prepared.headers, 180000);
  const ok = cast.status >= 200 && cast.status < 300;
  return { index, ok, status: cast.status, ms: Number(process.hrtime.bigint() - started) / 1e6,
    prepareCommitted: true, castAttempted: true, castCommitted: ok,
    prepareMs: committed.ms, castMs: cast.ms, error: ok ? null : (cast.body?.error || 'cast-vector failed') };
}

function systemSnapshot() {
  const snapshot = {};
  try { snapshot.dockerStats = execSync("docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}'", { encoding: 'utf8', timeout: 10000 }); } catch {}
  return snapshot;
}

async function measureExactTally(electionID, expectedResults, closeTimeoutMs = 360000) {
  const close = await post(`/api/elections/${electionID}/close`, {}, {}, closeTimeoutMs);
  if (close.status >= 400) return { success: false, error: `close failed: ${close.status}`, closeMs: +close.ms.toFixed(1) };
  const partials = [];
  for (const shareIndex of ['1', '2']) {
    let partial;
    let attempts = 0;
    const partialStarted = Date.now();
    const propagationDeadline = Date.now() + 90_000;
    do {
      attempts += 1;
      partial = await post(`/api/elections/${electionID}/partial-decryptions`, { shareIndex }, {}, 180000);
      if (partial.status < 400 || Date.now() >= propagationDeadline) break;
      // 집계 커밋 직후 다른 조직 peer의 state DB 반영을 기다린다.
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (true);
    partial.attempts = attempts;
    partial.elapsedWithPropagationMs = Date.now() - partialStarted;
    partials.push(partial);
    if (partial.status >= 400) return { success: false, error: `partial ${shareIndex} failed: ${partial.status}` };
  }
  const tally = await get(`/api/elections/${electionID}/tally`);
  const body = tally.body || {};
  const results = body.results || {};
  const proofCount = Array.isArray(body.vectorPartialDecryptions) ? body.vectorPartialDecryptions.length : 0;
  const exact = tally.status < 400 && body.decrypted === true && proofCount >= 2 &&
    CANDIDATES.every(candidate => results[candidate] === expectedResults[candidate]);
  return {
    success: exact,
    error: exact ? null : `exact threshold tally mismatch (status=${tally.status}, proofs=${proofCount})`,
    expectedResults,
    actualResults: results,
    totalVotes: body.totalVotes,
    vectorPartialDecryptionProofs: proofCount,
    closeMs: +close.ms.toFixed(1),
    partialMs: +partials.reduce((sum, item) => sum + item.elapsedWithPropagationMs, 0).toFixed(1),
    partialAttempts: partials.map(item => item.attempts),
    readMs: +tally.ms.toFixed(1),
  };
}

// ── 동시성 라운드 ───────────────────────────────────────────────
async function runConcurrency(label, concurrency, idemixEnabled) {
  console.log(`\n  [${label}] C=${concurrency} — 선거 생성...`);
  const { electionID, pubKey, blindingFactor } = await createElection(`${label}-c${concurrency}`);

  const credentials = [];
  if (idemixEnabled) {
    for (let i = 0; i < concurrency; i++) credentials.push(await issueCredential(electionID, i + 1));
  } else {
    for (let i = 0; i < concurrency; i++) credentials.push({ credential: '', nullifierMaterial: `bypass-${i}` });
  }

  console.log(`  vector-v3 ballot ${concurrency}건 사전 생성...`);
  const prepared = credentials.map((credential, i) => prepareVote(electionID, pubKey, blindingFactor, i, credential));

  console.log(`  투표 ${concurrency}건 동시 제출 (ElGamal + ZKP)...`);
  const before = systemSnapshot();
  const started = Date.now();

  // 동시 투표 실행
  const results = await Promise.all(
    prepared.map(castPreparedVote)
  );

  const elapsedSec = (Date.now() - started) / 1000;
  const after = systemSnapshot();

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const overloadErrorCount = fail.filter(r => r.status === 0 || r.status >= 500).length;
  const contractErrorCount = fail.length - overloadErrorCount;
  const errors = {};
  for (const r of fail) {
    const key = `${r.status}:${(r.error || '').slice(0, 120)}`;
    errors[key] = (errors[key] || 0) + 1;
  }
  const expectedResults = Object.fromEntries(CANDIDATES.map(candidate => [candidate, 0]));
  for (const result of ok) expectedResults[CANDIDATES[result.index % CANDIDATES.length]] += 1;
  console.log('  threshold exact tally 검증...');
  const tally = await measureExactTally(electionID, expectedResults);

  const round = {
    electionID,
    concurrency,
    success: ok.length,
    fail: fail.length,
    overloadErrorCount,
    contractErrorCount,
    failRate: +((fail.length / concurrency) * 100).toFixed(2),
    tps: +(ok.length / elapsedSec).toFixed(2),
    elapsedSec: +elapsedSec.toFixed(2),
    latency: stats(ok.map(r => r.ms)),
    errors,
    failedSamples: fail.slice(0, 20).map(({ index, status, ms, error }) => ({ index, status, ms: +ms.toFixed(1), error })),
    tally,
  };

  console.log(`  성공=${round.success}/${concurrency} TPS=${round.tps} avg=${round.latency.avg}ms P95=${round.latency.p95}ms fail=${round.failRate}%`);
  return round;
}

// ── 메인 ────────────────────────────────────────────────────────
async function main() {
  if (!ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN is required');
  if (CONCURRENCIES.some(c => !Number.isInteger(c) || c < 1 || c > 1000)) throw new Error('concurrency must be an integer from 1 to 1000');
  const health = await get('/health');
  if (health.status !== 200) throw new Error('API server not ready');
  if (health.body?.benchmark?.rateLimitsDisabled !== true) {
    throw new Error('concurrency benchmark requires an isolated backend with DISABLE_RATE_LIMITS=true');
  }
  const idemix = health.body.idemix || {};

  const label = !idemix.enabled
    ? 'bypass'
    : idemix.idemixImpl === 'ps' ? 'PS-BN254'
    : idemix.idemixImpl === 'bbs' ? 'BBS'
    : 'Ed25519';

  console.log('═══════════════════════════════════════════════════');
  console.log(` ElGamal Concurrency Benchmark: ${label}`);
  console.log(` 동시성 레벨: ${CONCURRENCIES.join(', ')}`);
  console.log('═══════════════════════════════════════════════════');

  const rounds = [];
  for (const c of CONCURRENCIES) {
    const round = await runConcurrency(label, c, idemix.enabled);
    rounds.push(round);

    if (round.failRate >= STOP_FAIL_RATE) {
      console.log(`\n  [STOP] failRate ${round.failRate}% >= ${STOP_FAIL_RATE}% — 포화 도달`);
      break;
    }
  }

  const result = {
    schema: 'mongbas-elgamal-concurrency/v2',
    evidenceClass: 'saturation-performance',
    scenario: `elgamal-concurrency-${label}`,
    timestamp: new Date().toISOString(),
    config: { encryptionMode: 'elgamal-vector-v3', candidates: CANDIDATES.length, idemix, stopFailRate: STOP_FAIL_RATE, rateLimitsDisabled: true },
    rounds,
  };

  result.evidenceValid = rounds.length > 0 && rounds.every(round =>
    round.success + round.fail === round.concurrency &&
    round.latency.n === round.success &&
    round.contractErrorCount === 0 &&
    round.tally?.success === true);

  writeJsonEvidenceExclusive(OUT, result);

  // 요약 테이블
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' 요약');
  console.log('═══════════════════════════════════════════════════');
  console.log(' C      | TPS    | avg(ms) | P95(ms) | fail%');
  console.log('--------|--------|---------|---------|------');
  for (const r of rounds) {
    console.log(` ${String(r.concurrency).padStart(6)} | ${String(r.tps).padStart(6)} | ${String(r.latency.avg).padStart(7)} | ${String(r.latency.p95).padStart(7)} | ${r.failRate}%`);
  }

  console.log(`\n결과 저장: ${OUT}`);
  if (!result.evidenceValid) {
    throw new Error('concurrency evidence contract failed; diagnostic result retained');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}

// The fixed-rate benchmark reuses the exact same live-election preparation and
// strict tally oracle. Keeping one implementation avoids a faster but invalid
// benchmark path that bypasses vector-v3 proofs or credential binding.
module.exports = {
  CANDIDATES,
  get,
  createElection,
  issueCredential,
  prepareVote,
  castPreparedVote,
  measureExactTally,
  stats,
  systemSnapshot,
};
