'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { expectedBoundNullifier, voterOwnsDemoEvent } = require('../src/lib/demoVerificationEvent');

test('demo verification event is bound to credential, election, blinding factor and ledger vote', () => {
  const electionID = 'election-a';
  const material = 'signed-nullifier-material';
  const blindingFactor = 'public-election-blinding-factor';
  const nullifierHash = expectedBoundNullifier(material, electionID, blindingFactor);
  const valid = { voter: { electionID, nullifierMaterial: material }, electionID, nullifierHash, blindingFactor,
    ledgerNullifier: { electionID, nullifierHash } };
  assert.equal(voterOwnsDemoEvent(valid), true);
  for (const changed of [
    { electionID: 'election-b' }, { nullifierHash: '0'.repeat(64) }, { blindingFactor: 'changed' },
    { voter: { electionID, nullifierMaterial: 'other' } }, { ledgerNullifier: null },
  ]) assert.equal(voterOwnsDemoEvent({ ...valid, ...changed }), false);
});

test('demo verification event rejects malformed hashes and missing material', () => {
  assert.equal(voterOwnsDemoEvent({ voter: {}, electionID: 'e', nullifierHash: 'bad' }), false);
  assert.equal(expectedBoundNullifier('', 'e', 'b'), '');
});
