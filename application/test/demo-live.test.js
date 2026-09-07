'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const demoLive = require('../src/lib/demoLive');

test('revote replaces the active ballot but appends a separate opaque commit event', () => {
  const electionID = `DEMO_LIVE_${Date.now()}`;
  demoLive.reset(electionID);

  demoLive.recordVote(electionID, {
    nullifierHash: 'same-nullifier', ciphertext: 'first-c1:first-c2', zkpValid: true,
  });
  demoLive.recordVote(electionID, {
    nullifierHash: 'same-nullifier', ciphertext: 'second-c1:second-c2', zkpValid: true,
  });

  const result = demoLive.listVotes(electionID);
  assert.equal(result.count, 1, 'only the latest ballot remains active');
  assert.equal(result.votes.length, 1);
  assert.equal(result.votes[0].c1, 'second-c1');
  assert.equal(result.votes[0].revoted, true);
  assert.equal(result.castCount, 2, 'both successful casts appear in the append-only display feed');
  assert.deepEqual(result.castEvents.map((event) => event.seq), [1, 2]);

  const publicFeed = JSON.stringify(result.castEvents);
  assert.doesNotMatch(publicFeed, /same-nullifier|first-c1|second-c1|revote|supersession/i);
});

test('reset clears both active ballots and the commit display feed', () => {
  const electionID = `DEMO_LIVE_RESET_${Date.now()}`;
  demoLive.recordVote(electionID, { nullifierHash: 'n', ciphertext: 'a:b', zkpValid: true });
  demoLive.reset(electionID);
  const result = demoLive.listVotes(electionID);
  assert.equal(result.count, 0);
  assert.equal(result.castCount, 0);
  assert.deepEqual(result.castEvents, []);
});
