'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { parseAdminLocalPort, parsePublicVoterOrigin, localAdminHandler, isLocalAdminRequest, LOCAL_ADMIN } = require('../src/lib/localAdmin');
const { validateRuntimeSecurity } = require('../src/lib/runtimeSecurity');

test('admin listener port is opt-in, bounded and never in production', () => {
  assert.equal(parseAdminLocalPort({}), null);
  assert.equal(parseAdminLocalPort({ ADMIN_LOCAL_PORT: '3001', PORT: '3000' }), 3001);
  for (const bad of ['0', '80', '70000', 'abc', '3000']) {
    assert.throws(() => parseAdminLocalPort({ ADMIN_LOCAL_PORT: bad, PORT: '3000' }), /ADMIN_LOCAL_PORT/);
  }
  assert.throws(() => parseAdminLocalPort({ ADMIN_LOCAL_PORT: '3001', NODE_ENV: 'production' }), /운영/);
});

test('public voter origin must be an exact https origin listed in CORS', () => {
  assert.equal(parsePublicVoterOrigin({ PUBLIC_VOTER_ORIGIN: 'https://booth.example' }), 'https://booth.example');
  for (const bad of ['http://booth.example', 'https://booth.example/', 'https://u:p@booth.example', 'nope']) {
    assert.throws(() => parsePublicVoterOrigin({ PUBLIC_VOTER_ORIGIN: bad }), /PUBLIC_VOTER_ORIGIN/);
  }
  assert.throws(() => validateRuntimeSecurity({ PUBLIC_VOTER_ORIGIN: 'https://booth.example' }), /CORS_ORIGIN/);
  const ok = validateRuntimeSecurity({ PUBLIC_VOTER_ORIGIN: 'https://booth.example', CORS_ORIGIN: 'https://booth.example', ADMIN_LOCAL_PORT: '3001' });
  assert.ok(ok.allowedOrigins.includes('http://localhost:3001'));
});

test('only requests through the loopback admin listener are marked', () => {
  const fake = (marked, remoteAddress, headers = {}) => ({ [LOCAL_ADMIN]: marked, socket: { remoteAddress }, headers });
  assert.equal(isLocalAdminRequest(fake(true, '127.0.0.1')), true);
  assert.equal(isLocalAdminRequest(fake(true, '10.0.0.8')), false);
  assert.equal(isLocalAdminRequest(fake(undefined, '127.0.0.1', { 'x-mongbas-local-admin': 'true' })), false);
});

test('admin routes pass on the admin listener and stay locked on the public one', async () => {
  delete require.cache[require.resolve('../src/middleware/admin')];
  process.env.ADMIN_API_TOKEN = 'z'.repeat(48);
  const { requireAdmin } = require('../src/middleware/admin');
  const app = express();
  app.post('/admin', requireAdmin, (_req, res) => res.json({ ok: true }));
  const publicServer = http.createServer(app).listen(0, '127.0.0.1');
  const adminServer = http.createServer(localAdminHandler(app)).listen(0, '127.0.0.1');
  await Promise.all([new Promise((r) => publicServer.once('listening', r)), new Promise((r) => adminServer.once('listening', r))]);
  try {
    const pub = await fetch(`http://127.0.0.1:${publicServer.address().port}/admin`, { method: 'POST' });
    const adm = await fetch(`http://127.0.0.1:${adminServer.address().port}/admin`, { method: 'POST' });
    assert.equal(pub.status, 401);
    assert.equal(adm.status, 200);
  } finally {
    publicServer.close(); adminServer.close();
    delete process.env.ADMIN_API_TOKEN;
    delete require.cache[require.resolve('../src/middleware/admin')];
  }
});
