'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyFabricVoteRejection, errorText } = require('../src/lib/fabricRejection');

test('credential and bound-nullifier chaincode rejections map to generic 403', () => {
  for (const message of [
    '자격증명 거부: Ed25519 credential 선거ID 불일치: payload=secret, req=election',
    'nullifier 바인딩 거부: nullifierHash가 서명된 자격증명과 일치하지 않습니다',
  ]) {
    const classified = classifyFabricVoteRejection({
      message: '10 ABORTED: failed to endorse transaction',
      details: [{ address: 'peer', message }],
    });
    assert.equal(classified.status, 403);
    assert.deepEqual(classified.body, { error: '투표 자격증명과 요청이 일치하지 않습니다.' });
    assert.doesNotMatch(JSON.stringify(classified), /payload=secret|election/);
  }
});

test('unknown Fabric and infrastructure errors are not misclassified as client rejection', () => {
  for (const error of [
    new Error('connection refused'),
    { message: '10 ABORTED: failed to endorse transaction' },
    { message: 'deadline exceeded', details: [{ message: 'peer unavailable' }] },
  ]) assert.equal(classifyFabricVoteRejection(error), null);
});

test('Fabric detail extraction accepts gateway string and object shapes', () => {
  assert.match(errorText({ message: 'outer', details: 'inner' }), /outer\ninner/);
  assert.match(errorText({ details: ['one', { message: 'two' }, null] }), /one\ntwo/);
});
