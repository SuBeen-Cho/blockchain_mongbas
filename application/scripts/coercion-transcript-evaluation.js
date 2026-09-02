#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateThreshold, trainThreshold, wilsonInterval } = require('../src/lib/coercionClassifier');
const { deriveLookupToken } = require('../src/lib/deniableProof');

const BASE_URL = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3005').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const OUTPUT_DIR = process.env.COERCION_OUTPUT_DIR || '';
const SAMPLES_PER_CLASS = Number(process.env.COERCION_SAMPLES_PER_CLASS || 50);
const CANDIDATES = ['ALPHA', 'BETA'];

function sha256Hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function requestJson(route, options = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${BASE_URL}${route}`, { ...options, headers: {
    'content-type': 'application/json', ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
    ...(options.headers || {}),
  } });
  const bytes = Buffer.from(await response.arrayBuffer());
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch { body = { raw: bytes.toString('utf8') }; }
  return { ok: response.ok, status: response.status, body, bodyBytes: bytes.length, elapsedMs };
}

async function ok(label, promise) {
  const result = await promise;
  if (!result.ok) throw new Error(`${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

function shuffledLabels(count) {
  const labels = [...Array(count).fill('normal'), ...Array(count).fill('panic')];
  for (let index = labels.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [labels[index], labels[swap]] = [labels[swap], labels[index]];
  }
  return labels;
}

function splitBalanced(rows) {
  const training = [], testing = [];
  for (const label of ['normal', 'panic']) {
    const group = rows.filter(row => row.label === label);
    const cut = Math.floor(group.length * 0.7);
    training.push(...group.slice(0, cut));
    testing.push(...group.slice(cut));
  }
  return { training, testing };
}

async function main() {
  if (!ADMIN_API_TOKEN || !OUTPUT_DIR) throw new Error('ADMIN_API_TOKEN and COERCION_OUTPUT_DIR are required');
  if (!Number.isInteger(SAMPLES_PER_CLASS) || SAMPLES_PER_CLASS < 20 || SAMPLES_PER_CLASS > 1000) {
    throw new Error('COERCION_SAMPLES_PER_CLASS must be an integer from 20 to 1000');
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  const electionID = `coercion-eval-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  await ok('health', requestJson('/health'));
  await ok('create', requestJson('/api/elections', { method: 'POST', body: JSON.stringify({
    electionID, title: 'Coercion transcript evaluation', candidates: CANDIDATES,
    startTime: now - 10, endTime: now + 3600, encryptionMode: 'aes',
  }) }));
  await ok('activate', requestJson(`/api/elections/${encodeURIComponent(electionID)}/activate`, { method: 'POST', body: '{}' }));
  // The isolated evaluator deliberately uses the explicit demo registry enabled
  // by deploy/linux/coercion-evaluation.sh. Arbitrary generated identities are
  // not registered voters and would only measure a credential-authentication
  // failure rather than the normal/panic transcript.
  const enrollmentID = `demo${String(crypto.randomInt(1, 1001)).padStart(3, '0')}`;
  const enrollmentSecret = `${enrollmentID}pw`;
  const issued = await ok('credential', requestJson('/api/credential/idemix', { method: 'POST', body: JSON.stringify({
    enrollmentID, enrollmentSecret, electionID,
  }) }));
  const blinding = await ok('blinding', requestJson(`/api/elections/${encodeURIComponent(electionID)}/blinding-factor`));
  const nullifierHash = sha256Hex(issued.nullifierMaterial + electionID + blinding.blindingFactor);
  const normalPassword = crypto.randomBytes(32).toString('hex');
  const panicPassword = crypto.randomBytes(32).toString('hex');
  const verificationNonce = crypto.randomBytes(32).toString('hex');
  const normalLookupToken = deriveLookupToken(normalPassword, verificationNonce, electionID);
  const panicLookupToken = deriveLookupToken(panicPassword, verificationNonce, electionID);
  await ok('cast', requestJson('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': issued.credential }, body: JSON.stringify({
    electionID, candidateID: CANDIDATES[0], nullifierHash, normalLookupToken, panicLookupToken, panicCandidateID: CANDIDATES[1],
  }) }));
  await ok('close', requestJson(`/api/elections/${encodeURIComponent(electionID)}/close`, { method: 'POST', body: '{}' }));
  await ok('merkle', requestJson(`/api/elections/${encodeURIComponent(electionID)}/merkle`, { method: 'POST', body: '{}' }));

  const lookupTokens = { normal: normalLookupToken, panic: panicLookupToken };
  for (const label of ['normal', 'panic', 'normal', 'panic']) {
    await ok(`warmup-${label}`, requestJson(`/api/elections/${encodeURIComponent(electionID)}/proof`, {
      method: 'POST', body: JSON.stringify({ lookupToken: lookupTokens[label] }),
    }));
  }
  const rows = [];
  for (const [sequence, label] of shuffledLabels(SAMPLES_PER_CLASS).entries()) {
    const result = await requestJson(`/api/elections/${encodeURIComponent(electionID)}/proof`, {
      method: 'POST', body: JSON.stringify({ lookupToken: lookupTokens[label] }),
    });
    if (!result.ok) throw new Error(`sample ${sequence} ${label}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
    const proof = result.body?.proof;
    rows.push({ sequence, label, elapsedMs: result.elapsedMs, bodyBytes: result.bodyBytes, status: result.status,
      topLevelKeys: Object.keys(result.body || {}).sort(), proofKeys: Object.keys(proof || {}).sort(),
      exposesTargetNullifier: Object.hasOwn(proof || {}, 'nullifierHash') || Object.hasOwn(result.body || {}, 'nullifierHash'),
      merklePathLength: Array.isArray(proof?.proof) ? proof.proof.length : -1 });
  }
  const { training, testing } = splitBalanced(rows);
  const timingModel = trainThreshold(training, 'elapsedMs');
  const sizeModel = trainThreshold(training, 'bodyBytes');
  const summary = {
    schema: 'mongbas-coercion-transcript-evaluation/v1', electionID, samplesPerClass: SAMPLES_PER_CLASS,
    totalSamples: rows.length,
    responseKeyShapes: [...new Set(rows.map(row => JSON.stringify([row.topLevelKeys, row.proofKeys])))].length,
    targetNullifierExposure: { exposedSamples: rows.filter(row => row.exposesTargetNullifier).length, total: rows.length },
    timingClassifier: { model: timingModel, test: evaluateThreshold(timingModel, testing) },
    bodySizeClassifier: { model: sizeModel, test: evaluateThreshold(sizeModel, testing) },
    securityGatePass: rows.every(row => !row.exposesTargetNullifier) &&
      evaluateThreshold(sizeModel, testing).accuracy <= 0.60 && evaluateThreshold(timingModel, testing).accuracy <= 0.60,
    limitation: 'Same-host API-transcript evaluation only. PDC/backend collusion, public revote patterns, compromised clients and independent network acquisition remain separate failing or untested games.',
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'samples.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.securityGatePass) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 2; });
