'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConcurrencyGate } = require('../src/lib/fabricConcurrencyGate');

test('limit 초과 요청은 slot 반환 후 진입한다', async () => {
  const gate = new ConcurrencyGate({ limit: 1, maxQueue: 2, waitTimeoutMs: 1000 });
  const releaseFirst = await gate.acquire();
  let entered = false;
  const second = gate.acquire().then((release) => { entered = true; return release; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false);
  assert.deepEqual(gate.status(), { limit: 1, active: 1, queued: 1, maxQueue: 2 });
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(entered, true);
  releaseSecond();
  assert.equal(gate.status().active, 0);
});

test('대기열이 가득 차면 명시적 오류를 반환한다', async () => {
  const gate = new ConcurrencyGate({ limit: 1, maxQueue: 1, waitTimeoutMs: 1000 });
  const release = await gate.acquire();
  const queued = gate.acquire();
  await assert.rejects(gate.acquire(), { code: 'FABRIC_QUEUE_FULL' });
  release();
  (await queued)();
});

test('대기 시간 초과 요청은 queue에서 제거된다', async () => {
  const gate = new ConcurrencyGate({ limit: 1, maxQueue: 1, waitTimeoutMs: 20 });
  const release = await gate.acquire();
  await assert.rejects(gate.acquire(), { code: 'FABRIC_QUEUE_TIMEOUT' });
  assert.equal(gate.status().queued, 0);
  release();
});
