'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BENCHMARK_SCENARIOS,
  isSuccessfulHttpStatus,
  requireHttpSuccess,
  isAcceptedAuth,
  requireAcceptedAuth,
  requireExactSuccess,
  requireRequestSeries,
  requireBenchmarkHealth,
  writeJsonEvidenceExclusive,
} = require('../benchmark/evidence-contract');

function healthyScenario(name) {
  return {
    status: 'ok',
    idemix: { ...BENCHMARK_SCENARIOS[name] },
    benchmark: { authEndpointEnabled: true, rateLimitsDisabled: true, demoCredentialsEnabled: true },
  };
}

test('benchmark HTTP success accepts only 2xx', () => {
  assert.equal(isSuccessfulHttpStatus(200), true);
  assert.equal(isSuccessfulHttpStatus(299), true);
  for (const status of [0, 199, 300, 399, 400, 403, 499, 500, undefined]) {
    assert.equal(isSuccessfulHttpStatus(status), false, String(status));
  }
  assert.throws(() => requireHttpSuccess({ status: 403 }, 'auth'), /expected HTTP 2xx/);
  assert.equal(isAcceptedAuth({ status: 200, body: { eligible: true } }), true);
  assert.equal(isAcceptedAuth({ status: 200, body: { eligible: false } }), false);
  assert.equal(isAcceptedAuth({ status: 403, body: { eligible: true } }), false);
  assert.throws(() => requireAcceptedAuth({ status: 200, body: { eligible: false } }, 'auth'), /expected accepted authentication/);
});

test('benchmark readiness is bound to the exact requested scenario and unsafe flags', () => {
  assert.doesNotThrow(() => requireBenchmarkHealth(healthyScenario('B'), 'B'));
  assert.throws(() => requireBenchmarkHealth(healthyScenario('B'), 'C'), /readiness mismatch/);
  const missingEndpoint = healthyScenario('A');
  missingEndpoint.benchmark.authEndpointEnabled = false;
  assert.throws(() => requireBenchmarkHealth(missingEndpoint, 'A'), /readiness mismatch/);
  assert.throws(() => requireBenchmarkHealth(healthyScenario('A'), 'unknown'), /unknown benchmark scenario/);
});

test('evidence publication is atomic and never overwrites an existing result', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'result.json');
  writeJsonEvidenceExclusive(target, { evidenceValid: true, sample: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { evidenceValid: true, sample: 1 });
  assert.throws(() => writeJsonEvidenceExclusive(target, { evidenceValid: false }), error => error.code === 'EEXIST');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { evidenceValid: true, sample: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['result.json']);
});

test('benchmark runners explicitly enable their isolated test surface and never kill an unknown port owner', () => {
  for (const name of ['run-comparison.sh', 'run-real-idemix.sh']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'benchmark', name), 'utf8');
    assert.match(source, /NODE_ENV=development/);
    assert.match(source, /ENABLE_BENCH_ENDPOINTS=true/);
    assert.match(source, /ENABLE_DEMO_CREDENTIALS=true/);
    assert.match(source, /authEndpointEnabled === true/);
    assert.match(source, /demoCredentialsEnabled === true/);
    assert.match(source, /--scenario/);
    assert.doesNotMatch(source, /\beval\b/);
    assert.doesNotMatch(source, /xargs\s+kill|kill\s+-9/);
  }
});

test('supported ElGamal benchmarks publish an explicit validity verdict without overwriting evidence', () => {
  for (const name of ['elgamal-e2e-bench.js', 'elgamal-concurrency-bench.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'benchmark', name), 'utf8');
    assert.match(source, /evidenceValid/);
    assert.match(source, /evidenceClass/);
    assert.match(source, /writeJsonEvidenceExclusive\(OUT,/);
    assert.doesNotMatch(source, /fs\.writeFileSync\(OUT,/);
  }
});

test('benchmark exact-success gate rejects empty, partial and failed evidence', () => {
  assert.doesNotThrow(() => requireExactSuccess('issuance', 50, 50, 0));
  assert.throws(() => requireExactSuccess('issuance', 50, 49, 1), /incomplete evidence/);
  assert.throws(() => requireExactSuccess('issuance', 0, 0, 0), /incomplete evidence/);
});

test('benchmark request-series gate rejects 4xx/error or missing samples', () => {
  assert.doesNotThrow(() => requireRequestSeries('auth', {
    total: 10, successCount: 8, overloadErrorCount: 2, contractErrorCount: 0, latency: { n: 8 },
  }));
  assert.throws(() => requireRequestSeries('auth', {
    total: 10, successCount: 9, overloadErrorCount: 0, contractErrorCount: 1, latency: { n: 9 },
  }), /invalid request series/);
  assert.throws(() => requireRequestSeries('auth', {
    total: 0, successCount: 0, overloadErrorCount: 0, contractErrorCount: 0, latency: { n: 0 },
  }), /invalid request series/);
});
