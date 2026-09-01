'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { submitTransactionAndWait } = require('../src/lib/submitTransaction');

function fakeContract({ successful = true, code = 0 } = {}) {
  const calls = [];
  const result = Buffer.from('{"status":"audited"}');
  return {
    calls,
    result,
    contract: {
      newProposal(name, options) {
        calls.push(['proposal', name, options]);
        return {
          async endorse() {
            calls.push(['endorse']);
            return {
              getResult() { calls.push(['result']); return result; },
              async submit() {
                calls.push(['submit']);
                return { async getStatus() { calls.push(['status']); return { successful, code }; } };
              },
            };
          },
        };
      },
    },
  };
}

test('state-changing ballot audit is endorsed, submitted and commit-checked', async () => {
  const fake = fakeContract();
  const result = await submitTransactionAndWait(fake.contract, 'AuditBallot', ['election-a', 'ballot-a']);
  assert.equal(result, fake.result);
  assert.deepEqual(fake.calls, [
    ['proposal', 'AuditBallot', { arguments: ['election-a', 'ballot-a'] }],
    ['endorse'], ['result'], ['submit'], ['status'],
  ]);
});

test('failed Fabric commit is never returned as a successful ballot audit', async () => {
  const fake = fakeContract({ successful: false, code: 11 });
  await assert.rejects(
    submitTransactionAndWait(fake.contract, 'AuditBallot', ['election-a', 'ballot-a']),
    error => error.code === 'FABRIC_COMMIT_FAILED' && error.commitStatus === 11,
  );
});
