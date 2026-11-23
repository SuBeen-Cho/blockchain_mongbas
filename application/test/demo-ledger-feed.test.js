'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const demoLive = require('../src/lib/demoLive');

test('ledger feed shows block, transaction and ciphertext prefix but never the nullifier', () => {
  const election = `FEED_${Date.now()}`;
  const nullifierHash = 'ab'.repeat(32);
  demoLive.reset(election);
  demoLive.recordVote(election, { nullifierHash, ciphertext: '[vector-v3]', zkpValid: true,
    ledger: { blockNumber: '1302', transactionId: 'C0FFEE'.repeat(10) + 'ab12', ciphertext: '4be10a7f'.repeat(8) } });
  demoLive.recordVote(election, { nullifierHash, ciphertext: '[vector-v3]', zkpValid: true,
    ledger: { blockNumber: '1303', transactionId: 'f'.repeat(64), ciphertext: '9'.repeat(64) } });
  const { castEvents } = demoLive.listVotes(election);
  assert.equal(castEvents.length, 2, 'a revote is a new ledger entry');
  assert.deepEqual(castEvents.map((e) => e.block), ['1302', '1303']);
  assert.equal(castEvents[0].cipher, '4be10a7f'.repeat(8));
  assert.equal(castEvents[0].tx, ('C0FFEE'.repeat(10) + 'ab12').toLowerCase());
  const serialized = JSON.stringify(castEvents);
  assert.ok(!serialized.includes(nullifierHash), 'nullifier must not appear in the public feed');
  assert.ok(!/revot|supersed|replace/i.test(serialized), 'no revote linkage in the feed');
});

test('ledger feed drops malformed values instead of echoing them', () => {
  const election = `FEED_BAD_${Date.now()}`;
  demoLive.reset(election);
  demoLive.recordVote(election, { nullifierHash: 'cd'.repeat(32), ciphertext: '[vector-v3]',
    ledger: { blockNumber: '<script>', transactionId: 'not hex!', ciphertext: '<img>' } });
  const [event] = demoLive.listVotes(election).castEvents;
  assert.deepEqual([event.block, event.tx, event.cipher], ['', '', '']);
});
