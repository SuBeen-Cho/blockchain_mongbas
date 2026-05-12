#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] ?? true;
});

const BASE = args.url || 'http://localhost:3000';
const OUT = args.out || path.join(__dirname, '../benchmark-reports/e2e-vote-auth-latest.json');
const TPS_LEVELS = (args.tps || '1,5,10,20').split(',').map(Number).filter(Boolean);
const TX_PER_ROUND = parseInt(args.tx || '40', 10);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function rawRequest(method, urlPath, body = null, headers = {}, timeoutMs = 30000) {
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

const get = (path, headers = {}) => rawRequest('GET', path, null, headers);
const post = (path, body, headers = {}, timeoutMs) => rawRequest('POST', path, body, headers, timeoutMs);

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function issueCredential(electionID) {
  const res = await post('/api/credential/idemix', {
    enrollmentID: 'voter1',
    enrollmentSecret: 'voter1pw',
    electionID,
  });
  if (res.status !== 200 || !res.body?.credential) {
    throw new Error(`credential issuance failed: status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  return {
    credential: res.body.credential,
    credType: res.body.credType,
    sizeBytes: Buffer.byteLength(res.body.credential, 'utf8'),
    latencyMs: +res.ms.toFixed(2),
  };
}

async function createElection(label) {
  const electionID = `e2e-auth-${label}-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const create = await post('/api/elections', {
    electionID,
    title: `E2E Auth Bench ${label}`,
    description: 'auth mode e2e benchmark',
    candidates: ['A', 'B', 'C'],
    startTime: now,
    endTime: now + 7200,
  });
  if (create.status >= 400) throw new Error(`create election failed: ${create.status} ${JSON.stringify(create.body)}`);
  const activate = await post(`/api/elections/${electionID}/activate`, {});
  if (activate.status >= 400) throw new Error(`activate election failed: ${activate.status} ${JSON.stringify(activate.body)}`);
  return electionID;
}

async function measureRound(label, targetTps, txCount, idemixEnabled) {
  const electionID = await createElection(`${label}-tps${targetTps}`);
  let credentialInfo = null;
  let authHeaders = {};
  if (idemixEnabled) {
    credentialInfo = await issueCredential(electionID);
    authHeaders = { 'x-idemix-credential': credentialInfo.credential };
  }
  const intervalMs = 1000 / targetTps;
  const latencies = [];
  const errors = {};
  let success = 0;
  const started = Date.now();

  for (let i = 0; i < txCount; i++) {
    const t0 = Date.now();
    const nullifierHash = sha256(`e2e-${label}-${targetTps}-${i}-${Date.now()}` + electionID);
    try {
      const res = await post('/api/vote', {
        electionID,
        candidateID: ['A', 'B', 'C'][i % 3],
        nullifierHash,
        voterID: `bench-voter-${i}`,
      }, authHeaders, 30000);
      if (res.status >= 200 && res.status < 300) {
        success++;
        latencies.push(res.ms);
      } else {
        const key = `${res.status}:${res.body?.error || res.body?.reason || 'error'}`.slice(0, 120);
        errors[key] = (errors[key] || 0) + 1;
      }
    } catch (err) {
      const key = `exception:${err.message}`.slice(0, 120);
      errors[key] = (errors[key] || 0) + 1;
    }
    const elapsed = Date.now() - t0;
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    process.stdout.write(`\r  ${label} TPS ${targetTps}: ${i + 1}/${txCount} success=${success}`);
  }
  process.stdout.write('\n');

  const elapsedSec = (Date.now() - started) / 1000;
  return {
    targetTps,
    txCount,
    success,
    fail: txCount - success,
    failRate: +(((txCount - success) / txCount) * 100).toFixed(2),
    actualTps: +(success / elapsedSec).toFixed(2),
    elapsedSec: +elapsedSec.toFixed(2),
    latency: stats(latencies),
    credential: credentialInfo && {
      credType: credentialInfo.credType,
      sizeBytes: credentialInfo.sizeBytes,
      latencyMs: credentialInfo.latencyMs,
    },
    errors,
  };
}

async function main() {
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

  console.log(`\n=== E2E CastVote auth benchmark: ${label} ===`);
  console.log(`mode=${idemix.mode} impl=${idemix.impl}`);

  const rounds = [];
  for (const targetTps of TPS_LEVELS) {
    rounds.push(await measureRound(label, targetTps, TX_PER_ROUND, idemix.enabled));
    await sleep(1500);
  }

  const result = {
    label,
    timestamp: new Date().toISOString(),
    health: { idemix, memory: health.body.memory },
    txPerRound: TX_PER_ROUND,
    rounds,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`result saved: ${OUT}`);
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
