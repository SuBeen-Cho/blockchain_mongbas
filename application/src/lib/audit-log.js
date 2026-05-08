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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _stream = fs.createWriteStream(AUDIT_PATH, { flags: 'a' });
  return _stream;
}

/**
 * credential 발급 감사 로그를 기록한다.
 *
 * 기록 항목: credentialHash, electionID, credType, issuedAt, expiresAt, success
 * 금지 항목: credential token 원문, candidateID, nullifierHash, enrollmentID 평문
 */
function logCredentialIssuance({ credentialHash: precomputedHash, electionID, credType, expiresAt, success }) {
  if (!AUDIT_ENABLED) return;

  const credentialHash = precomputedHash || 'unknown';

  const entry = {
    credentialHash,
    electionID,
    credType,
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    success: !!success,
  };

  getStream().write(JSON.stringify(entry) + '\n');
}

/**
 * credential 발급 실패 감사 로그를 기록한다.
 */
function logCredentialFailure({ electionID, reason }) {
  if (!AUDIT_ENABLED) return;

  const entry = {
    credentialHash: null,
    electionID: electionID || null,
    credType: null,
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    success: false,
    reason,
  };

  getStream().write(JSON.stringify(entry) + '\n');
}

module.exports = { logCredentialIssuance, logCredentialFailure, AUDIT_ENABLED };
