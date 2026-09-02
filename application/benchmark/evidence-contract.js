'use strict';

const fs = require('fs');
const path = require('path');

const BENCHMARK_SCENARIOS = Object.freeze({
  A: Object.freeze({ enabled: false, mode: 'bypass', impl: 'HMAC-SHA256', idemixImpl: 'hmac', asymEnabled: false }),
  HMAC: Object.freeze({ enabled: true, mode: 'idemix-hmac', impl: 'HMAC-SHA256', idemixImpl: 'hmac', asymEnabled: false }),
  Ed25519: Object.freeze({ enabled: true, mode: 'idemix-hmac', impl: 'Ed25519-asymmetric', idemixImpl: 'hmac', asymEnabled: true }),
  B: Object.freeze({ enabled: true, mode: 'idemix-ps', impl: 'PS-BN254 credential prototype', idemixImpl: 'ps', asymEnabled: false }),
  C: Object.freeze({ enabled: true, mode: 'idemix-bbs', impl: 'BBS+-BLS12381 (C단계: 개선 Idemix)', idemixImpl: 'bbs', asymEnabled: false }),
});

function isSuccessfulHttpStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function requireHttpSuccess(response, label) {
  if (!response || !isSuccessfulHttpStatus(response.status)) {
    const status = response?.status ?? 'missing';
    throw new Error(`${label}: expected HTTP 2xx, got ${status}`);
  }
  return response;
}

function isAcceptedAuth(response) {
  return Boolean(response && isSuccessfulHttpStatus(response.status) &&
    response.body && response.body.eligible === true);
}

function requireAcceptedAuth(response, label) {
  if (!isAcceptedAuth(response)) {
    const status = response?.status ?? 'missing';
    const eligible = response?.body?.eligible;
    throw new Error(`${label}: expected accepted authentication (status=${status}, eligible=${eligible})`);
  }
  return response;
}

function requireExactSuccess(label, attempted, succeeded, failed = attempted - succeeded) {
  if (!Number.isInteger(attempted) || attempted <= 0 || !Number.isInteger(succeeded) ||
      !Number.isInteger(failed) || succeeded !== attempted || failed !== 0) {
    throw new Error(`${label}: incomplete evidence (${succeeded}/${attempted} succeeded, ${failed} failed)`);
  }
}

function requireRequestSeries(label, series) {
  const total = series?.total;
  const succeeded = series?.successCount;
  const overloadErrors = series?.overloadErrorCount;
  const contractErrors = series?.contractErrorCount;
  const samples = series?.latency?.n;
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(succeeded) || succeeded <= 0 ||
      !Number.isInteger(overloadErrors) || overloadErrors < 0 || contractErrors !== 0 ||
      samples !== succeeded || total !== succeeded + overloadErrors + contractErrors) {
    throw new Error(`${label}: invalid request series (total=${total}, success=${succeeded}, samples=${samples}, overload=${overloadErrors}, contract=${contractErrors})`);
  }
}

function requireBenchmarkHealth(health, scenarioName) {
  const expected = BENCHMARK_SCENARIOS[scenarioName];
  if (!expected) throw new Error(`unknown benchmark scenario: ${scenarioName}`);
  const actual = health?.idemix;
  const identityMatches = actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
  if (health?.status !== 'ok' || !identityMatches ||
      health?.benchmark?.authEndpointEnabled !== true ||
      health?.benchmark?.rateLimitsDisabled !== true ||
      health?.benchmark?.demoCredentialsEnabled !== true) {
    throw new Error(`benchmark readiness mismatch for scenario ${scenarioName}`);
  }
  return health;
}

function writeJsonEvidenceExclusive(targetPath, value) {
  const resolved = path.resolve(targetPath);
  const directory = path.dirname(resolved);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // A hard link makes publication atomic and refuses to replace existing evidence.
    fs.linkSync(temporary, resolved);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

module.exports = {
  BENCHMARK_SCENARIOS,
  isSuccessfulHttpStatus,
  requireHttpSuccess,
  isAcceptedAuth,
  requireAcceptedAuth,
  requireExactSuccess,
  requireRequestSeries,
  requireBenchmarkHealth,
  writeJsonEvidenceExclusive,
};
