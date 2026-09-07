'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyApiError } = require('../src/lib/apiError');

const cases = [
  ['MVCC_READ_CONFLICT on key', 'FABRIC_MVCC_CONFLICT', 409, true],
  ['transaction already committed', 'ALREADY_COMMITTED', 409, false],
  ['Merkle tree가 아직 구축되지 않았습니다', 'MERKLE_NOT_BUILT', 409, false],
  ['감사 데이터가 아직 게시되지 않았습니다', 'BULLETIN_NOT_PUBLISHED', 409, false],
  ['cast vector receipt artifact mismatch', 'AUDIT_EVIDENCE_MISMATCH', 422, false],
  ['electionID 형식이 잘못되었습니다', 'INVALID_INPUT', 400, false],
  ['14 UNAVAILABLE: connection closed', 'INFRASTRUCTURE_UNAVAILABLE', 503, true],
];

for (const [message, code, status, retryable] of cases) {
  test(`classifies ${code} without exposing Fabric details`, () => {
    const result = classifyApiError(new Error(message));
    assert.equal(result.code, code);
    assert.equal(result.status, status);
    assert.equal(result.retryable, retryable);
    assert.equal(result.error.includes(message), false);
  });
}

test('unknown internal messages are not reflected', () => {
  const result = classifyApiError(new Error('peer0 secret path /private/key'));
  assert.deepEqual(result, { error: '요청을 처리할 수 없습니다.', code: 'INTERNAL_ERROR', retryable: false, status: 500 });
});
