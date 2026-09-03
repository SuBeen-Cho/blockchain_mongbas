import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const frontendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('mock capstone QR flow issues, redeems once, and relays a dashboard event', async t => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['mock-server.js'], { cwd: frontendDirectory,
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 20));
    if (attempt === 49) assert.fail('mock server did not become ready');
  }

  assert.equal((await request(base, '/api/elections', { electionID: 'qr-test', title: 'QR test',
    candidates: ['A', 'B'], encryptionMode: 'elgamal-vector-v3' })).status, 200);
  assert.equal((await request(base, '/api/elections/qr-test/activate', {})).status, 200);
  const issued = await request(base, '/api/credential/demo-admission', { electionID: 'qr-test', ttlSeconds: 120 });
  assert.equal(issued.status, 200);
  assert.match(issued.body.token, /^[A-Za-z0-9_-]{43}$/);
  const redeemed = await request(base, '/api/credential/demo-admission/redeem', {
    electionID: 'qr-test', token: issued.body.token,
  });
  assert.equal(redeemed.status, 200);
  assert.ok(redeemed.body.credential);
  assert.match(redeemed.body.nullifierMaterial, /^[0-9a-f]{64}$/);
  assert.equal((await request(base, '/api/credential/demo-admission/redeem', {
    electionID: 'qr-test', token: issued.body.token,
  })).status, 401);

  assert.equal((await request(base, '/api/vote/demo-event', {
    electionID: 'qr-test', nullifierHash: 'ab'.repeat(32),
  })).status, 200);
  const events = await request(base, '/api/elections/qr-test/demo-events?since=0');
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].type, 'verify');
});
