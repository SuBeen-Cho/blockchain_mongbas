'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DemoAdmissionStore } = require('../src/lib/demoAdmission');

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test backend exited with ${child.exitCode}`);
    try { if ((await fetch(`${baseURL}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test backend readiness timeout');
}

test('demo admission is election-bound, expires, persists and redeems exactly once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-admission-'));
  try {
    const file = path.join(directory, 'admissions.json');
    const store = new DemoAdmissionStore(file);
    const issued = store.issue('election-a', { now: 1_000, ttlMs: 5_000 });
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.expiresAt, 6_000);
    assert.throws(() => store.redeem('election-b', issued.token, { now: 2_000 }), /invalid or unavailable/);
    const redeemed = store.redeem('election-a', issued.token, { now: 2_000 });
    assert.match(redeemed.admissionID, /^[0-9a-f]{64}$/);
    assert.equal(redeemed.electionID, 'election-a');
    assert.throws(() => store.redeem('election-a', issued.token, { now: 2_001 }), /invalid or unavailable/);
    assert.throws(() => new DemoAdmissionStore(file).redeem('election-a', issued.token, { now: 2_002 }), /invalid or unavailable/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(issued.token));

    const expired = store.issue('election-a', { now: 10_000, ttlMs: 1_000 });
    assert.throws(() => store.redeem('election-a', expired.token, { now: 11_001 }), /invalid or unavailable/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('demo admission rejects symlink state and malformed token/election/TTL', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-admission-invalid-'));
  try {
    const target = path.join(directory, 'target.json');
    const link = path.join(directory, 'link.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, link);
    assert.throws(() => new DemoAdmissionStore(link), /regular non-symlink/);
    const store = new DemoAdmissionStore(path.join(directory, 'state.json'));
    assert.throws(() => store.issue('../bad', { now: 1, ttlMs: 1_000 }), /electionID/);
    assert.throws(() => store.issue('good', { now: 1, ttlMs: 0 }), /ttlMs/);
    assert.throws(() => store.redeem('good', 'not-a-token', { now: 1 }), /invalid or unavailable/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('demo admission recovers only a well-formed lock owned by a dead process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-admission-stale-lock-'));
  try {
    const file = path.join(directory, 'state.json');
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, '2147483647\n', { mode: 0o600 });
    assert.doesNotThrow(() => new DemoAdmissionStore(file).issue('election-a', { now: 1_000, ttlMs: 5_000 }));
    assert.equal(fs.existsSync(lock), false);

    fs.writeFileSync(lock, 'not-a-pid\n', { mode: 0o600 });
    assert.throws(() => new DemoAdmissionStore(file).issue('election-a', { now: 2_000, ttlMs: 5_000 }), /busy/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'not-a-pid\n');

    fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    assert.throws(() => new DemoAdmissionStore(file).issue('election-a', { now: 3_000, ttlMs: 5_000 }), /busy/);
    assert.equal(fs.readFileSync(lock, 'utf8'), `${process.pid}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent processes cannot redeem one admission more than once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-admission-race-'));
  try {
    const file = path.join(directory, 'state.json');
    const issued = new DemoAdmissionStore(file).issue('election-a', { now: 1_000, ttlMs: 5_000 });
    const modulePath = path.join(__dirname, '../src/lib/demoAdmission.js');
    const program = [
      "const { DemoAdmissionStore } = require(process.argv[1]);",
      "try { new DemoAdmissionStore(process.argv[2]).redeem('election-a', process.argv[3], { now: 2_000 }); process.exit(0); }",
      'catch { process.exit(1); }',
    ].join(' ');
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', program, modulePath, file, issued.token], { stdio: 'ignore' });
      child.on('exit', code => resolve(code));
    })));
    assert.equal(results.filter(code => code === 0).length, 1, `unexpected statuses: ${results.join(',')}`);
    assert.throws(() => new DemoAdmissionStore(file).redeem('election-a', issued.token, { now: 2_001 }), /invalid or unavailable/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP admission creation is admin-only and redemption returns one election credential', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-admission-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  const adminToken = 'a'.repeat(48);
  let output = '';
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ENABLE_DEMO_ENDPOINTS: 'true',
      ENABLE_DEMO_CREDENTIALS: 'true', REQUIRE_DEMO_ADMISSION: 'true',
      ADMIN_API_TOKEN: adminToken, CREDENTIAL_SECRET: 'c'.repeat(48), AUDIT_HMAC_KEY: 'd'.repeat(48),
      CORS_ORIGIN: `http://127.0.0.1:${port}`, DEMO_ADMISSION_FILE: path.join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const baseURL = `http://127.0.0.1:${port}`;
  await waitForHealth(baseURL, child);
  const body = JSON.stringify({ electionID: 'election-a', ttlSeconds: 30 });
  const unauthorized = await fetch(`${baseURL}/api/credential/demo-admission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(unauthorized.status, 401);

  const bypass = await fetch(`${baseURL}/api/credential/idemix`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollmentID: 'demo001', enrollmentSecret: 'demo001pw', electionID: 'election-qr' }),
  });
  assert.equal(bypass.status, 403);
  const created = await fetch(`${baseURL}/api/credential/demo-admission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body,
  });
  assert.equal(created.status, 201);
  const admission = await created.json();
  assert.match(admission.token, /^[A-Za-z0-9_-]{43}$/);

  const wrongElection = await fetch(`${baseURL}/api/credential/demo-admission/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ electionID: 'election-b', token: admission.token }),
  });
  assert.equal(wrongElection.status, 401);
  const redeem = () => fetch(`${baseURL}/api/credential/demo-admission/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ electionID: 'election-a', token: admission.token }),
  });
  const accepted = await redeem();
  assert.equal(accepted.status, 200);
  const credential = await accepted.json();
  assert.ok(credential.credential);
  assert.ok(credential.nullifierMaterial);
  assert.equal((await redeem()).status, 401);
  assert.doesNotMatch(output, new RegExp(admission.token));
});
