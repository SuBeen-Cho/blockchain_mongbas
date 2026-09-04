'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourcePseudonym, credentialPseudonym } = require('../src/lib/audit-log');

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
  delete process.env.AUDIT_HMAC_KEY;
  process.env.CREDENTIAL_SECRET = 'credential-domain-must-not-be-reused'.repeat(2);
  try { assert.equal(sourcePseudonym('203.0.113.7'), null); }
  finally {
    if (originalAudit === undefined) delete process.env.AUDIT_HMAC_KEY; else process.env.AUDIT_HMAC_KEY = originalAudit;
    if (originalCredential === undefined) delete process.env.CREDENTIAL_SECRET; else process.env.CREDENTIAL_SECRET = originalCredential;
  }
});

test('credential audit uses a separately-domain-bound HMAC, never the raw token hash', () => {
  const original = process.env.AUDIT_HMAC_KEY;
  process.env.AUDIT_HMAC_KEY = 'b'.repeat(32);
  try {
    const rawHash = 'c'.repeat(64);
    const pseudonym = credentialPseudonym(rawHash);
    assert.match(pseudonym, /^[0-9a-f]{64}$/);
    assert.notEqual(pseudonym, rawHash);
    assert.notEqual(pseudonym, sourcePseudonym(rawHash));
    assert.equal(pseudonym, credentialPseudonym(rawHash));
  } finally {
    if (original === undefined) delete process.env.AUDIT_HMAC_KEY;
    else process.env.AUDIT_HMAC_KEY = original;
  }
});

test('credential audit omits its pseudonym without a dedicated strong audit key', () => {
  const original = process.env.AUDIT_HMAC_KEY;
  delete process.env.AUDIT_HMAC_KEY;
  try { assert.equal(credentialPseudonym('d'.repeat(64)), null); }
  finally {
    if (original === undefined) delete process.env.AUDIT_HMAC_KEY;
    else process.env.AUDIT_HMAC_KEY = original;
  }
});

test('Linux runtime provisioning creates an independent audit HMAC key', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../deploy/linux/prepare-runtime.sh'), 'utf8');
  assert.match(source, /audit_hmac_key="\$\(openssl rand -base64 48\)"/);
  assert.match(source, /AUDIT_HMAC_KEY=\$\{audit_hmac_key\}/);
  assert.doesNotMatch(source, /AUDIT_HMAC_KEY=\$\{credential_secret\}/);
});
