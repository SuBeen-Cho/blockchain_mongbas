'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('global rate-limit bypass is restricted to exact authenticated dashboard reads', () => {
  const token = 'r'.repeat(48);
  const { skipAuthenticatedDashboardRead } = loadAdmin({ ADMIN_API_TOKEN: token, NODE_ENV: 'production' });
  const request = (method, requestPath, authorization = `Bearer ${token}`) => ({
    method, path: requestPath, get: name => name.toLowerCase() === 'authorization' ? authorization : '',
  });
  for (const route of ['live-count', 'live-votes', 'demo-events']) {
    assert.equal(skipAuthenticatedDashboardRead(request('GET', `/api/elections/election-a/${route}`)), true, route);
  }
  assert.equal(skipAuthenticatedDashboardRead(request('GET', '/api/elections/election-a/live-count', 'Bearer wrong')), false);
  assert.equal(skipAuthenticatedDashboardRead(request('POST', '/api/elections/election-a/live-count')), false);
  assert.equal(skipAuthenticatedDashboardRead(request('GET', '/api/elections/election-a/tally')), false);
  assert.equal(skipAuthenticatedDashboardRead(request('GET', '/api/elections/election-a/live-count/extra')), false);

  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.match(app, /rateLimit\(\{[\s\S]{0,300}skip:\s*skipAuthenticatedDashboardRead/);
  assert.match(app, /dashboardReadLimiter\s*=\s*rateLimit\(\{[\s\S]{0,300}max:\s*900,[\s\S]{0,200}skip:\s*\(req\)\s*=>\s*!skipAuthenticatedDashboardRead\(req\)/);
  assert.match(app, /app\.use\(dashboardReadLimiter\)/);
});

test('every public mutation router has an explicit authentication boundary', () => {
  const { PUBLIC_POST_PATH } = loadAdmin({ ADMIN_API_TOKEN: 'd'.repeat(48) });
  const elections = fs.readFileSync(path.join(__dirname, '../src/routes/elections.js'), 'utf8');
  const electionPosts = [...elections.matchAll(/router\.post\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(electionPosts.sort(), [
    '/', '/:id/activate', '/:id/close', '/:id/dkg-approvals', '/:id/external-partial-decryptions',
    '/:id/keysharing', '/:id/legacy-demo-event-disabled', '/:id/merkle', '/:id/partial-decryptions',
    '/:id/proof', '/:id/publish-audit', '/:id/revoke-credential', '/:id/seed-votes', '/:id/shares',
    '/:id/verify-elgamal', '/:id/verify-public', '/:id/verify-tally',
  ].sort());
  const publicPosts = electionPosts.filter(route => PUBLIC_POST_PATH.test(route.replace(':id', 'e')));
  assert.deepEqual(publicPosts.sort(), ['/:id/proof', '/:id/verify-elgamal', '/:id/verify-public'].sort());

  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.match(app, /app\.use\('\/api\/elections', guardElectionAdminRoutes, electionsRouter\)/);
  assert.match(app, /app\.use\('\/api\/vote',[\s\S]{0,100}requireVoterAuth, voteRouter\)/);

  const credentials = fs.readFileSync(path.join(__dirname, '../src/routes/credential.js'), 'utf8');
  assert.match(credentials, /router\.post\('\/demo-admission', requireDemoEndpoint, requireAdmin,/);
  assert.match(credentials, /router\.post\('\/demo-admission\/redeem', requireDemoEndpoint,/);
  assert.match(credentials, /router\.post\('\/idemix',/);
});
