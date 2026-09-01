'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_ENABLED = process.env.CREDENTIAL_AUDIT_ENABLED === 'true';
const AUDIT_PATH = process.env.CREDENTIAL_AUDIT_PATH
  || path.join(__dirname, '..', '..', 'audit-logs', 'credential-issuance.jsonl');

let _stream = null;

function getStream() {
  if (_stream) return _stream;
  const dir = path.dirname(AUDIT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  _stream = fs.createWriteStream(AUDIT_PATH, { flags: 'a', mode: 0o600 });
  _stream.on('error', error => console.error('[audit] write failure:', error.message));
  return _stream;
}

function sourcePseudonym(sourceAddress) {
  if (!sourceAddress) return null;
  const key = process.env.AUDIT_HMAC_KEY || process.env.CREDENTIAL_SECRET || '';
  if (Buffer.byteLength(key) < 32) return null;
  return crypto.createHmac('sha256', key).update(`source:${sourceAddress}`).digest('hex');
}

function credentialPseudonym(credentialHash) {
  if (!credentialHash) return null;
  const key = process.env.AUDIT_HMAC_KEY || '';
  if (Buffer.byteLength(key) < 32) return null;
  return crypto.createHmac('sha256', key)
    .update(`credential:${credentialHash}`)
    .digest('hex');
}

function writeEntry(entry) {
  if (!AUDIT_ENABLED) return;
  const safe = {
    schema: 'mongbas-security-audit/v1',
    eventType: entry.eventType,
    occurredAt: new Date().toISOString(),
    outcome: entry.outcome,
    reason: entry.reason || null,
    method: entry.method || null,
    route: entry.route || null,
    electionID: entry.electionID || null,
    credentialPseudonym: entry.credentialPseudonym || null,
    credentialType: entry.credentialType || null,
    expiresAt: entry.expiresAt || null,
    sourcePseudonym: sourcePseudonym(entry.sourceAddress),
  };
  getStream().write(`${JSON.stringify(safe)}\n`);
}

/**
 * credential 발급 감사 로그를 기록한다.
 *
 * 기록 항목: keyed credential pseudonym, electionID, credType, expiresAt, success
 * 금지 항목: credential token 원문, candidateID, nullifierHash, enrollmentID 평문
 */
function logCredentialIssuance({ credentialHash: precomputedHash, electionID, credType, expiresAt, success }) {
  if (!AUDIT_ENABLED) return;

  writeEntry({
    eventType: 'credential-issuance', outcome: success ? 'success' : 'failure',
    credentialPseudonym: credentialPseudonym(precomputedHash), electionID, credentialType: credType,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  });
}

/**
 * credential 발급 실패 감사 로그를 기록한다.
 */
function logCredentialFailure({ electionID, reason }) {
  if (!AUDIT_ENABLED) return;

  writeEntry({ eventType: 'credential-issuance', outcome: 'failure', electionID, reason });
}

function logAdminAuthorization({ success, method, route, reason, sourceAddress }) {
  writeEntry({
    eventType: 'admin-authorization', outcome: success ? 'success' : 'failure',
    method, route, reason, sourceAddress,
  });
}

module.exports = {
  logCredentialIssuance,
  logCredentialFailure,
  logAdminAuthorization,
  sourcePseudonym,
  credentialPseudonym,
  AUDIT_ENABLED,
};
