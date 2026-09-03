'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCastHistoryTransient } = require('../src/lib/castHistory');

test('cast history transient uses two independent canonical 256-bit nonces', () => {
  const values = [Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb)];
  const transient = createCastHistoryTransient(() => values.shift());
  assert.equal(transient.castHistoryCommitmentNonce.toString(), 'aa'.repeat(32));
  assert.equal(transient.castHistoryReceiptNonce.toString(), 'bb'.repeat(32));
  assert.deepEqual(Object.keys(transient).sort(), ['castHistoryCommitmentNonce', 'castHistoryReceiptNonce']);
});

test('cast history transient rejects an impossible RNG collision', () => {
  assert.throws(() => createCastHistoryTransient(() => Buffer.alloc(32, 7)), /collision/);
});

test('all HTTP cast paths require the history-producing chaincode transactions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/vote.js'), 'utf8');
  assert.match(source, /newProposal\('CastVoteWithHistory'/);
  assert.match(source, /'CastPreparedVectorBallotWithHistory'/);
  assert.doesNotMatch(source, /newProposal\('CastVote'/);
  assert.doesNotMatch(source, /submitTransactionAndWait\([^\n]+, 'CastPreparedVectorBallot'/);
  assert.match(source, /createCastHistoryTransient\(\)/);
});
