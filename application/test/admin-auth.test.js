'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = require.resolve('../src/middleware/admin');

function loadAdmin(env = {}) {
  const original = {
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_INSECURE_ADMIN_API: process.env.ALLOW_INSECURE_ADMIN_API,
  };
  for (const key of Object.keys(original)) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[MODULE];
  const loaded = require(MODULE);
  for (const key of Object.keys(original)) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  return loaded;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('admin guard rejects a missing token', () => {
  const token = 'a'.repeat(48);
  const { requireAdmin } = loadAdmin({ ADMIN_API_TOKEN: token, NODE_ENV: 'production' });
  const res = responseRecorder();
  let nextCalled = false;
  requireAdmin({ get: () => '' }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('admin guard rejects a wrong token and accepts an exact bearer token', () => {
  const token = 'b'.repeat(48);
  const { requireAdmin } = loadAdmin({ ADMIN_API_TOKEN: token, NODE_ENV: 'production' });
  const rejected = responseRecorder();
  requireAdmin({ get: () => 'Bearer wrong' }, rejected, () => assert.fail('wrong token accepted'));
  assert.equal(rejected.statusCode, 401);

  const accepted = responseRecorder();
  let nextCalled = false;
  requireAdmin({ get: () => `Bearer ${token}` }, accepted, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(accepted.body, null);
});

test('production refuses a short or missing admin token', () => {
  assert.throws(
    () => loadAdmin({ ADMIN_API_TOKEN: 'short', NODE_ENV: 'production' }).validateAdminConfiguration(),
    /ADMIN_API_TOKEN/,
  );
});

test('route classifier protects state changes and share retrieval only', () => {
  const { PUBLIC_POST_PATH, ADMIN_GET_PATH } = loadAdmin({ ADMIN_API_TOKEN: 'c'.repeat(48) });
  for (const path of ['/', '/e/activate', '/e/close', '/e/merkle', '/e/keysharing', '/e/shares',
    '/e/partial-decryptions', '/e/publish-audit', '/e/seed-votes', '/e/verify-tally',
    '/e/revoke-credential', '/e/demo-event', '/e/future-state-change']) {
    assert.equal(PUBLIC_POST_PATH.test(path), false, path);
  }
  for (const path of ['/e/proof', '/e/verify-public', '/e/verify-elgamal']) {
    assert.equal(PUBLIC_POST_PATH.test(path), true, path);
  }
  assert.equal(ADMIN_GET_PATH.test('/e/shares/1'), true);
  assert.equal(ADMIN_GET_PATH.test('/e/tally'), false);
});
