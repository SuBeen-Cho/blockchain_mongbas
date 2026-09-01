'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrustProxyHops, validateRuntimeSecurity } = require('../src/lib/runtimeSecurity');

test('production refuses benchmark/demo/rate-limit bypass flags', () => {
  for (const flag of ['ALLOW_INSECURE_ADMIN_API', 'ALLOW_BYPASS_CREDENTIAL', 'DISABLE_RATE_LIMITS', 'ENABLE_BENCH_ENDPOINTS', 'ENABLE_DEMO_CREDENTIALS', 'ENABLE_DEMO_ENDPOINTS']) {
    assert.throws(() => validateRuntimeSecurity({ NODE_ENV: 'production', CORS_ORIGIN: 'https://vote.example', ASYM_CRED_ENABLED: 'true', [flag]: 'true' }), new RegExp(flag));
  }
});

test('production requires explicit CORS and an asymmetric credential mode', () => {
  assert.throws(() => validateRuntimeSecurity({ NODE_ENV: 'production', ASYM_CRED_ENABLED: 'true' }), /CORS_ORIGIN/);
  assert.throws(() => validateRuntimeSecurity({ NODE_ENV: 'production', CORS_ORIGIN: 'https://vote.example' }), /asymmetric credential/);
  assert.equal(validateRuntimeSecurity({ NODE_ENV: 'production', CORS_ORIGIN: 'https://vote.example', ASYM_CRED_ENABLED: 'true' }).production, true);
});

test('trust proxy is explicit and bounded', () => {
  assert.equal(parseTrustProxyHops('0'), 0);
  assert.equal(parseTrustProxyHops('1'), 1);
  assert.throws(() => parseTrustProxyHops('true'), /TRUST_PROXY_HOPS/);
  assert.throws(() => parseTrustProxyHops('3'), /TRUST_PROXY_HOPS/);
});

test('CORS accepts exact origins and rejects wildcard/path/userinfo', () => {
  assert.deepEqual(validateRuntimeSecurity({ CORS_ORIGIN: 'https://vote.example,http://127.0.0.1:5173' }).allowedOrigins,
    ['https://vote.example', 'http://127.0.0.1:5173']);
  for (const value of ['*', 'https://vote.example/path', 'https://user:pass@vote.example']) {
    assert.throws(() => validateRuntimeSecurity({ CORS_ORIGIN: value }), /CORS/);
  }
});

test('benchmark endpoint requires explicit non-production enablement', () => {
  assert.equal(validateRuntimeSecurity({ ENABLE_BENCH_ENDPOINTS: 'true' }).benchEndpoints, true);
  assert.equal(validateRuntimeSecurity({}).benchEndpoints, false);
});
