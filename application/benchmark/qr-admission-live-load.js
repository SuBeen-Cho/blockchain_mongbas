#!/usr/bin/env node
'use strict';

const baseURL = String(process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminToken = process.env.ADMIN_API_TOKEN || '';
const clients = Number(process.env.QR_LOAD_CLIENTS || 20);
const electionID = `QR_ADMISSION_LOAD_${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('percentile requires non-empty non-negative measurements');
  }
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

async function timedRequest(path, { admin = false, ...options } = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(options.headers || {}) },
  });
  await response.arrayBuffer();
  return { status: response.status, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

async function jsonRequest(path, { admin = false, ...options } = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
      ...(options.headers || {}) },
  });
  const body = await response.json();
  return { status: response.status, body, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

function requireAll(label, rows, status) {
  const failures = rows.filter(row => row.status !== status);
  if (failures.length) throw new Error(`${label}: ${failures.length}/${rows.length} requests did not return ${status}`);
}

function latencySummary(rows) {
  const values = rows.map(row => row.elapsedMs);
  return { p50Ms: percentile(values, 0.50), p95Ms: percentile(values, 0.95), p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values) };
}

async function main() {
  if (!Number.isSafeInteger(clients) || clients < 2 || clients > 50) throw new Error('QR_LOAD_CLIENTS must be 2..50');
  if (adminToken.length < 32) throw new Error('ADMIN_API_TOKEN is required');
  const now = Math.floor(Date.now() / 1000);
  const created = await timedRequest('/api/elections', { admin: true, method: 'POST', body: JSON.stringify({
    electionID, title: 'QR admission bounded load', candidates: ['ALPHA', 'BRAVO'], startTime: now - 5,
    endTime: now + 3600, encryptionMode: 'aes',
  }) });
  if (created.status !== 201) throw new Error(`create election returned ${created.status}`);
  const activated = await timedRequest(`/api/elections/${electionID}/activate`, { admin: true, method: 'POST', body: '{}' });
  if (activated.status !== 200) throw new Error(`activate election returned ${activated.status}`);

  const issueStarted = process.hrtime.bigint();
  const issued = await Promise.all(Array.from({ length: clients }, () => jsonRequest('/api/credential/demo-admission', {
    admin: true, method: 'POST', body: JSON.stringify({ electionID, ttlSeconds: 120 }),
  })));
  const issueWallMs = Number(process.hrtime.bigint() - issueStarted) / 1e6;
  requireAll('issue', issued, 201);
  if (issued.some(row => !/^[A-Za-z0-9_-]{43}$/.test(row.body?.token || ''))) throw new Error('issued token shape mismatch');

  const redeemStarted = process.hrtime.bigint();
  const redeemed = await Promise.all(issued.map(row => timedRequest('/api/credential/demo-admission/redeem', {
    method: 'POST', body: JSON.stringify({ electionID, token: row.body.token }),
  })));
  const redeemWallMs = Number(process.hrtime.bigint() - redeemStarted) / 1e6;
  requireAll('redeem', redeemed, 200);

  const replayed = await Promise.all(issued.map(row => timedRequest('/api/credential/demo-admission/redeem', {
    method: 'POST', body: JSON.stringify({ electionID, token: row.body.token }),
  })));
  requireAll('replay', replayed, 401);

  process.stdout.write(`${JSON.stringify({ schema: 'mongbas-qr-admission-load/v1', clients,
    issue: { successes: clients, throughputPerSecond: clients / (issueWallMs / 1000), ...latencySummary(issued) },
    redeem: { successes: clients, throughputPerSecond: clients / (redeemWallMs / 1000), ...latencySummary(redeemed) },
    replay: { rejected: clients, ...latencySummary(replayed) } })}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`QR admission load failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { percentile };
