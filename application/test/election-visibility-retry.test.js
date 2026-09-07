'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isElectionVisibilityLag, electionVisibilityRetry } = require('../src/lib/electionVisibilityRetry');

test('only ABORTED missing-election endorsements are retried', () => {
  const lag = Object.assign(new Error('failed to collect enough endorsements'), {
    code: 10,
    details: [{ message: '체인코드 응답 500, 선거를 찾을 수 없습니다: DEMO_1' }],
  });
  assert.equal(isElectionVisibilityLag(lag), true);
  assert.equal(isElectionVisibilityLag(Object.assign(new Error('선거를 찾을 수 없습니다'), { code: 11 })), false);
  assert.equal(isElectionVisibilityLag(Object.assign(new Error('투표 유효성 오류'), { code: 10 })), false);
});

test('election visibility retry is bounded', () => {
  const retry = electionVisibilityRetry({ delaysMs: [0, 10], sleep: async () => {} });
  assert.equal(retry.maxRetries, 2);
  assert.equal(retry.delayMs(1), 10);
  assert.throws(() => electionVisibilityRetry({ delaysMs: [] }), /delays/);
  assert.throws(() => electionVisibilityRetry({ delaysMs: [10001] }), /delays/);
});
