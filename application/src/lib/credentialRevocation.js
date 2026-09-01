'use strict';

const crypto = require('crypto');

function computeCredentialRevocationHandle(material, electionID, blindingFactor) {
  const fields = [material, electionID, blindingFactor];
  if (fields.some(field => typeof field !== 'string' || field.length === 0)) {
    throw new TypeError('credential revocation inputs must be non-empty strings');
  }
  const hash = crypto.createHash('sha256');
  hash.update('mongbas/revocation/v1', 'utf8');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    if (bytes.length > 0xffffffff) throw new RangeError('credential revocation input is too long');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

module.exports = { computeCredentialRevocationHandle };
