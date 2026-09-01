'use strict';

const crypto = require('crypto');

function computeCredentialBoundNullifier(material, electionID, blindingFactor) {
  const fields = [material, electionID, blindingFactor];
  if (fields.some(field => typeof field !== 'string' || field.length === 0)) {
    throw new TypeError('credential nullifier inputs must be non-empty strings');
  }
  return crypto.createHash('sha256').update(material + electionID + blindingFactor).digest('hex');
}

module.exports = { computeCredentialBoundNullifier };
