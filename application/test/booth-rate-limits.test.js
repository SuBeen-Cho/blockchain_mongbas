'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRateLimits, RATE_LIMIT_DEFAULTS, validateRuntimeSecurity } = require('../src/lib/runtimeSecurity');
const { internalDemoHeaders, isInternalDemoCall, INTERNAL_DEMO_HEADER } = require('../src/lib/internalDemoCall');

test('rate limits default to the previous fixed budgets', () => {
  assert.deepEqual(parseRateLimits({}), { global: 300, vote: 30, credential: 50 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS, { global: 300, vote: 30, credential: 50 });
  assert.deepEqual(validateRuntimeSecurity({}).rateLimits, { global: 300, vote: 30, credential: 50 });
});

test('booth profile can raise each budget independently', () => {
  assert.deepEqual(
    parseRateLimits({ GLOBAL_RATE_LIMIT_MAX: '4000', VOTE_RATE_LIMIT_MAX: '1500', CREDENTIAL_RATE_LIMIT_MAX: '600' }),
    { global: 4000, vote: 1500, credential: 600 },
  );
  assert.deepEqual(parseRateLimits({ VOTE_RATE_LIMIT_MAX: '90' }), { global: 300, vote: 90, credential: 50 });
});

test('invalid budgets fail closed instead of silently disabling limits', () => {
  for (const value of ['0', '-1', '1.5', 'abc', '100001', ' 10', 'Infinity']) {
    assert.throws(() => parseRateLimits({ VOTE_RATE_LIMIT_MAX: value }), /VOTE_RATE_LIMIT_MAX/);
  }
});

function fakeRequest(headers, remoteAddress) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()], socket: { remoteAddress } };
}

test('internal demo exemption requires the per-process key over loopback', () => {
  const headers = internalDemoHeaders();
  assert.equal(isInternalDemoCall(fakeRequest(headers, '127.0.0.1')), true);
  assert.equal(isInternalDemoCall(fakeRequest(headers, '::ffff:127.0.0.1')), true);
  // Remote clients cannot use the key even if it leaked.
  assert.equal(isInternalDemoCall(fakeRequest(headers, '10.0.0.5')), false);
  // Loopback without the right key (e.g. tunnel-forwarded phones) stays limited.
  assert.equal(isInternalDemoCall(fakeRequest({}, '127.0.0.1')), false);
  const forged = headers[INTERNAL_DEMO_HEADER].replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal(isInternalDemoCall(fakeRequest({ [INTERNAL_DEMO_HEADER]: forged }, '127.0.0.1')), false);
  assert.equal(isInternalDemoCall(fakeRequest({ [INTERNAL_DEMO_HEADER]: 'short' }, '127.0.0.1')), false);
});
