'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyNullifierRecord, reconcileAmbiguousCast } = require('../benchmark/commit-reconciliation');

const expected = { electionID: 'election-1', nullifierHash: 'a'.repeat(64), ballotID: 'ballot-1' };

test('matching ledger nullifier confirms the exact prepared ballot', () => {
  assert.equal(classifyNullifierRecord({ ...expected, preparedBallotID: expected.ballotID }, expected), 'match');
});

test('wrong election, hash, or ballot is classified as a mismatch', () => {
  for (const field of ['electionID', 'nullifierHash', 'preparedBallotID']) {
    const record = { electionID: expected.electionID, nullifierHash: expected.nullifierHash,
      preparedBallotID: expected.ballotID, [field]: 'wrong' };
    assert.equal(classifyNullifierRecord(record, expected), 'mismatch');
  }
});

test('an absent record followed by a match is late-committed', async () => {
  const replies = [{ status: 404 }, { status: 200, body: { ...expected, preparedBallotID: expected.ballotID } }];
  const result = await reconcileAmbiguousCast(expected, { lookup: async () => replies.shift(), sleep: async () => {},
    timeoutMs: 100, intervalMs: 1, now: (() => { let time = 0; return () => ++time; })() });
  assert.equal(result.outcome, 'late-committed');
  assert.equal(result.committed, true);
  assert.equal(result.attempts, 2);
});

test('a conflicting ledger record is invalid-mismatched', async () => {
  const result = await reconcileAmbiguousCast(expected, { lookup: async () => ({ status: 200,
    body: { ...expected, electionID: 'wrong', preparedBallotID: expected.ballotID } }), sleep: async () => {}, timeoutMs: 100 });
  assert.equal(result.outcome, 'invalid-mismatched');
  assert.equal(result.committed, false);
});

test('an absent record through the deadline remains unresolved', async () => {
  const result = await reconcileAmbiguousCast(expected, { lookup: async () => ({ status: 404 }), sleep: async () => {},
    timeoutMs: 2, intervalMs: 1, now: (() => { let time = 0; return () => ++time; })() });
  assert.equal(result.outcome, 'unresolved');
  assert.equal(result.committed, false);
});
