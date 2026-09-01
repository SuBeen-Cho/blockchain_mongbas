'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sourcePseudonym } = require('../src/lib/audit-log');

test('audit source pseudonym is deterministic keyed HMAC and never raw address', () => {
  const original = process.env.AUDIT_HMAC_KEY;
  process.env.AUDIT_HMAC_KEY = 'a'.repeat(32);
  try {
    const first = sourcePseudonym('203.0.113.7');
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, sourcePseudonym('203.0.113.7'));
    assert.notEqual(first, sourcePseudonym('203.0.113.8'));
    assert.equal(first.includes('203.0.113.7'), false);
  } finally {
    if (original === undefined) delete process.env.AUDIT_HMAC_KEY;
    else process.env.AUDIT_HMAC_KEY = original;
  }
});

test('audit source pseudonym fails closed when no adequate key exists', () => {
  const originalAudit = process.env.AUDIT_HMAC_KEY;
  const originalCredential = process.env.CREDENTIAL_SECRET;
  process.env.AUDIT_HMAC_KEY = 'short';
  delete process.env.CREDENTIAL_SECRET;
  try { assert.equal(sourcePseudonym('203.0.113.7'), null); }
  finally {
    if (originalAudit === undefined) delete process.env.AUDIT_HMAC_KEY; else process.env.AUDIT_HMAC_KEY = originalAudit;
    if (originalCredential === undefined) delete process.env.CREDENTIAL_SECRET; else process.env.CREDENTIAL_SECRET = originalCredential;
  }
});
