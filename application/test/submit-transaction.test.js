'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { submitTransactionAndWait } = require('../src/lib/submitTransaction');
const {
  isPreparedVectorVisibilityLag,
  preparedVectorVisibilityRetry,
} = require('../src/lib/preparedVectorVisibilityRetry');

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

test('state-changing helper binds transient data into the endorsed proposal', async () => {
  const fake = fakeContract({ successful: true, code: 0 });
  const transientData = { vectorAuditArtifact: Buffer.from('{"example":true}') };
  await submitTransactionAndWait(fake.contract, 'PrepareVectorBallot', ['election-a', 'nullifier-a', 'nonce-a'], { transientData });
  assert.deepEqual(fake.calls[0], ['proposal', 'PrepareVectorBallot', {
    arguments: ['election-a', 'nullifier-a', 'nonce-a'], transientData,
  }]);
});

test('prepared-vector visibility lag is recognized only from an ABORTED endorsement detail', () => {
  const transient = Object.assign(new Error('failed to collect enough transaction endorsements'), {
    code: 10,
    details: [{ message: 'chaincode response 500, 준비된 vector ballot을 찾을 수 없습니다' }],
  });
  assert.equal(isPreparedVectorVisibilityLag(transient), true);
  assert.equal(isPreparedVectorVisibilityLag(Object.assign(new Error('준비된 vector ballot을 찾을 수 없습니다'), { code: 11 })), false);
  assert.equal(isPreparedVectorVisibilityLag(Object.assign(new Error('증명이 잘못되었습니다'), { code: 10 })), false);
});

test('prepared-vector cast retries endorsement visibility lag before submit', async () => {
  const calls = [];
  let endorsements = 0;
  const contract = {
    newProposal() {
      calls.push('proposal');
      return {
        async endorse() {
          calls.push('endorse');
          endorsements += 1;
          if (endorsements === 1) {
            throw Object.assign(new Error('endorsement failed'), {
              code: 10,
              details: [{ message: '준비된 vector ballot을 찾을 수 없습니다' }],
            });
          }
          return {
            getResult() { return Buffer.from('ok'); },
            async submit() {
              calls.push('submit');
              return { async getStatus() { calls.push('status'); return { successful: true, code: 0 }; } };
            },
          };
        },
      };
    },
  };
  const result = await submitTransactionAndWait(contract, 'CastPreparedVectorBallotWithHistory', [], {
    endorsementRetry: preparedVectorVisibilityRetry({ delaysMs: [0], sleep: async () => calls.push('sleep') }),
  });
  assert.equal(result.toString(), 'ok');
  assert.deepEqual(calls, ['proposal', 'endorse', 'sleep', 'proposal', 'endorse', 'submit', 'status']);
});

test('prepared-vector retry does not retry unrelated endorsement or commit failures', async () => {
  const unrelated = {
    newProposal() {
      return { async endorse() { throw Object.assign(new Error('증명이 잘못되었습니다'), { code: 10 }); } };
    },
  };
  await assert.rejects(submitTransactionAndWait(unrelated, 'CastPreparedVectorBallotWithHistory', [], {
    endorsementRetry: preparedVectorVisibilityRetry({ delaysMs: [0], sleep: async () => assert.fail('must not sleep') }),
  }), /증명/);

  const failedCommit = fakeContract({ successful: false, code: 11 });
  await assert.rejects(submitTransactionAndWait(failedCommit.contract, 'CastPreparedVectorBallotWithHistory', [], {
    endorsementRetry: preparedVectorVisibilityRetry({ delaysMs: [0], sleep: async () => assert.fail('must not retry commit') }),
  }), error => error.code === 'FABRIC_COMMIT_FAILED');
  assert.equal(failedCommit.calls.filter(call => call[0] === 'proposal').length, 1);
});
