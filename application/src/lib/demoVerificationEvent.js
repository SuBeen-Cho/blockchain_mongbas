'use strict';

const crypto = require('node:crypto');

function expectedBoundNullifier(material, electionID, blindingFactor) {
  if (typeof material !== 'string' || material.length === 0 ||
      typeof electionID !== 'string' || electionID.length === 0 ||
      typeof blindingFactor !== 'string' || blindingFactor.length === 0) return '';
  return crypto.createHash('sha256').update(material + electionID + blindingFactor).digest('hex');
}

function exactHashEqual(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left || '') || !/^[0-9a-f]{64}$/.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function voterOwnsDemoEvent({ voter, electionID, nullifierHash, blindingFactor, ledgerNullifier }) {
  if (!voter || voter.electionID !== electionID || ledgerNullifier?.electionID !== electionID ||
      ledgerNullifier?.nullifierHash !== nullifierHash) return false;
  return exactHashEqual(nullifierHash, expectedBoundNullifier(voter.nullifierMaterial, electionID, blindingFactor));
}

module.exports = { expectedBoundNullifier, exactHashEqual, voterOwnsDemoEvent };
