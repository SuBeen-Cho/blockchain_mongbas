'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bindClientLifecycle } = require('../src/gateway');

test('gateway close는 소유한 gRPC client를 정확히 한 번 닫는다', () => {
  let gatewayCloses = 0;
  let clientCloses = 0;
  const gateway = { close() { gatewayCloses += 1; } };
  const client = { close() { clientCloses += 1; } };
  bindClientLifecycle(gateway, client);
  gateway.close();
  gateway.close();
  assert.equal(gatewayCloses, 1);
  assert.equal(clientCloses, 1);
});

test('gateway close가 실패해도 gRPC client는 닫힌다', () => {
  let clientCloses = 0;
  const gateway = { close() { throw new Error('gateway close failed'); } };
  const client = { close() { clientCloses += 1; } };
  bindClientLifecycle(gateway, client);
  assert.throws(() => gateway.close(), /gateway close failed/);
  assert.equal(clientCloses, 1);
});
