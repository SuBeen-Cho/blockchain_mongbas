'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { closeAndAggregateElection } = require('../src/lib/closeElection');

function election(status) {
  return Buffer.from(JSON.stringify({ electionID: 'e1', status }));
}

test('close recovery aggregates an election already committed CLOSED', async () => {
  const submitted = [];
  const contract = {
    async evaluateTransaction() { return election('CLOSED'); },
    async submitTransaction(name, id) { submitted.push([name, id]); },
  };
  const result = await closeAndAggregateElection(contract, 'e1');
  assert.deepEqual(submitted, [['AggregateClosedElection', 'e1']]);
  assert.equal(result.closeAlreadyCommitted, true);
});

test('close recovery reconciles an ambiguous close error against ledger state', async () => {
  let reads = 0;
  const submitted = [];
  const contract = {
    async evaluateTransaction() { reads += 1; return election(reads === 1 ? 'ACTIVE' : 'CLOSED'); },
    async submitTransaction(name, id) {
      submitted.push([name, id]);
      if (name === 'CloseElection') throw new Error('deadline exceeded');
    },
  };
  const result = await closeAndAggregateElection(contract, 'e1');
  assert.deepEqual(submitted, [['CloseElection', 'e1'], ['AggregateClosedElection', 'e1']]);
  assert.equal(result.closeRecoveredAfterError, true);
});

test('close recovery does not hide an error when CLOSED is not committed', async () => {
  const contract = {
    async evaluateTransaction() { return election('ACTIVE'); },
    async submitTransaction() { throw new Error('endorsement failed'); },
  };
  await assert.rejects(closeAndAggregateElection(contract, 'e1'), /endorsement failed/);
});

test('close recovery rejects an invalid source state before mutation', async () => {
  let submitted = false;
  const contract = {
    async evaluateTransaction() { return election('CREATED'); },
    async submitTransaction() { submitted = true; },
  };
  await assert.rejects(closeAndAggregateElection(contract, 'e1'), /ACTIVE or CLOSED/);
  assert.equal(submitted, false);
});
