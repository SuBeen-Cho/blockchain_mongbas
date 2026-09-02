'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseURL, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test backend exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test backend readiness timeout');
}

test('static voter UI and assets receive the complete security-header policy', async t => {
  const dist = path.resolve(__dirname, '../../frontend/dist');
  assert.equal(fs.existsSync(path.join(dist, 'index.html')), true, 'frontend/dist must be built');
  const asset = fs.readdirSync(path.join(dist, 'assets')).find(name => name.endsWith('.js'));
  assert.ok(asset, 'built JavaScript asset is required');

  const port = await freePort();
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', CORS_ORIGIN: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForHealth(baseURL, child);

  for (const resource of ['/', `/assets/${asset}`]) {
    const response = await fetch(`${baseURL}${resource}`);
    assert.equal(response.status, 200, resource);
    assert.equal(response.headers.get('x-powered-by'), null, resource);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', resource);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', resource);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', resource);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', resource);
    const csp = response.headers.get('content-security-policy') || '';
    for (const directive of ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'"]) {
      assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${resource}: ${directive}`);
    }
  }

  const malformed = await fetch(`${baseURL}/api/elections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken":',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: '잘못된 JSON 요청입니다.' });

  const oversized = await fetch(`${baseURL}/api/elections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: '요청 본문이 허용 크기를 초과했습니다.' });

  for (const response of [malformed, oversized]) {
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
  }
});
