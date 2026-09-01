#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] ?? true;
});

const BASE = args.url || 'http://localhost:3000';
const OUT = args.out || path.join(__dirname, '../benchmark-reports/e2e-concurrency-latest.json');
const CONCURRENCIES = (args.conc || '20,50,100,200').split(',').map(Number).filter(Boolean);
const STOP_FAIL_RATE = Number(args.stopFailRate || 30);

function rawRequest(method, urlPath, body = null, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve) => {
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
    req.on('error', err => resolve({ status: 0, body: { error: err.message }, ms: Number(process.hrtime.bigint() - start) / 1e6 }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p, h = {}) => rawRequest('GET', p, null, h);
const post = (p, b, h = {}, t) => rawRequest('POST', p, b, h, t);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stats(values) {
  if (!values.length) return { n: 0, avg: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const p = pct => sorted[Math.max(0, Math.ceil((pct / 100) * n) - 1)];
  return {
    n,
    avg: +(sorted.reduce((a, b) => a + b, 0) / n).toFixed(1),
    min: +sorted[0].toFixed(1),
    p50: +p(50).toFixed(1),
    p95: +p(95).toFixed(1),
    p99: +p(99).toFixed(1),
    max: +sorted[n - 1].toFixed(1),
  };
}

function systemSnapshot() {
  const snapshot = {};
  try {
    snapshot.top = execSync("top -l 1 -s 0 | head -10", { encoding: 'utf8' });
  } catch (e) {
    snapshot.topError = e.message;
  }
  try {
    snapshot.dockerStats = execSync("docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}'", { encoding: 'utf8' });
  } catch (e) {
    snapshot.dockerStatsError = e.message;
  }
  return snapshot;
}

async function createElection(label) {
  const electionID = `sat-${label}-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const create = await post('/api/elections', {
    electionID,
    title: `Saturation ${label}`,
    description: 'concurrency saturation benchmark',
    candidates: ['A', 'B', 'C'],
    startTime: now,
    endTime: now + 7200,
  }, {}, 60000);
  if (create.status >= 400) throw new Error(`create election failed: ${create.status} ${JSON.stringify(create.body)}`);
  const activate = await post(`/api/elections/${electionID}/activate`, {}, {}, 60000);
  if (activate.status >= 400) throw new Error(`activate election failed: ${activate.status} ${JSON.stringify(activate.body)}`);
  return electionID;
}

async function issueCredential(electionID) {
  const res = await post('/api/credential/idemix', {
    enrollmentID: 'voter1',
    enrollmentSecret: 'voter1pw',
    electionID,
  }, {}, 30000);
  if (res.status !== 200 || !res.body?.credential) {
    throw new Error(`credential issuance failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    header: { 'x-idemix-credential': res.body.credential },
    info: {
      credType: res.body.credType,
      sizeBytes: Buffer.byteLength(res.body.credential, 'utf8'),
      latencyMs: +res.ms.toFixed(2),
    },
  };
}

async function castVote(electionID, i, headers) {
  const nullifierHash = sha256(`sat-${electionID}-${i}-${Date.now()}` + electionID);
  const res = await post('/api/vote', {
    electionID,
    candidateID: ['A', 'B', 'C'][i % 3],
    nullifierHash,
    voterID: `sat-voter-${i}`,
  }, headers, 90000);
  const ok = res.status >= 200 && res.status < 300;
  return { ok, status: res.status, ms: res.ms, error: ok ? null : (res.body?.error || res.body?.reason || JSON.stringify(res.body)) };
}

async function runConcurrency(label, concurrency, idemixEnabled) {
  const electionID = await createElection(`${label}-c${concurrency}`);
  let credential = null;
  let headers = {};
  if (idemixEnabled) {
    credential = await issueCredential(electionID);
    headers = credential.header;
  }

  const before = systemSnapshot();
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: concurrency }, (_, i) => castVote(electionID, i, headers)));
  const elapsedSec = (Date.now() - started) / 1000;
  const after = systemSnapshot();
  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const errors = {};
  for (const r of fail) {
    const key = `${r.status}:${r.error || 'error'}`.slice(0, 160);
    errors[key] = (errors[key] || 0) + 1;
  }
  return {
    concurrency,
    success: ok.length,
    fail: fail.length,
    failRate: +((fail.length / concurrency) * 100).toFixed(2),
    throughput: +(ok.length / elapsedSec).toFixed(2),
    elapsedSec: +elapsedSec.toFixed(2),
    latency: stats(ok.map(r => r.ms)),
    credential: credential?.info || null,
    errors,
    resource: { before, after },
  };
}

async function main() {
  if (process.env.ALLOW_LEGACY_AUTH_BENCHMARK !== 'true') {
    throw new Error(
      'legacy auth saturation benchmark is disabled because it does not use the vector-v3 ' +
      'credential-bound workload; use deploy/linux/rate-evaluation.sh',
    );
  }
  const health = await get('/health');
  if (health.status !== 200) throw new Error('API server is not ready');
  const idemix = health.body.idemix || {};
  const label = !idemix.enabled
    ? 'A-bypass'
    : idemix.idemixImpl === 'ps'
      ? 'B-PS-BN254'
      : idemix.idemixImpl === 'bbs'
        ? 'C-BBS'
        : idemix.asymEnabled
          ? 'Ed25519'
          : 'HMAC';

  console.log(`\n=== E2E concurrency saturation: ${label} ===`);
  console.log(`concurrency levels: ${CONCURRENCIES.join(', ')}`);
  const rounds = [];
  for (const concurrency of CONCURRENCIES) {
    console.log(`\n[${label}] concurrency=${concurrency}`);
    const round = await runConcurrency(label, concurrency, idemix.enabled);
    rounds.push(round);
    console.log(`  success=${round.success}/${concurrency} throughput=${round.throughput} TPS avg=${round.latency.avg}ms P95=${round.latency.p95}ms fail=${round.failRate}%`);
    if (round.failRate >= STOP_FAIL_RATE) {
      console.log(`  stop: failRate ${round.failRate}% >= ${STOP_FAIL_RATE}%`);
      break;
    }
  }

  const result = {
    evidenceClass: 'legacy-non-authoritative',
    label,
    timestamp: new Date().toISOString(),
    health: { idemix, memory: health.body.memory },
    concurrencies: CONCURRENCIES,
    stopFailRate: STOP_FAIL_RATE,
    rounds,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`result saved: ${OUT}`);
  if (rounds.length === 0 || rounds[0].success !== rounds[0].concurrency) {
    throw new Error('legacy saturation baseline round was not zero-failure; result retained but rejected');
  }
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
