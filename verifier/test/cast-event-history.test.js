'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCastEventHistory,
  createPrivateSelectionManifest,
  deriveCastEventContextHash,
  verifyCastEventHistory,
  verifyPrivateSelectionManifest,
} = require('../src/cast-event-history');

test('cast-event context binds immutable election configuration and rejects missing public key', () => {
  const election = { electionID: 'election-a', encryptionMode: 'elgamal-vector-v3', candidates: ['A', 'B'],
    startTime: 10, endTime: 20, blindingFactor: 'a'.repeat(64),
    elgamalPubKey: { p: '11', g: '2', y: '8' }, thresholdPublicShares: [{ index: 1, value: '4' }] };
  const baseline = deriveCastEventContextHash(election);
  assert.match(baseline, /^[0-9a-f]{64}$/);
  for (const mutation of [
    { ...election, electionID: 'election-b' },
    { ...election, candidates: ['B', 'A'] },
    { ...election, endTime: 21 },
    { ...election, blindingFactor: 'b'.repeat(64) },
    { ...election, elgamalPubKey: { ...election.elgamalPubKey, y: '9' } },
    { ...election, thresholdPublicShares: [{ index: 1, value: '5' }] },
  ]) assert.notEqual(deriveCastEventContextHash(mutation), baseline);
  assert.throws(() => deriveCastEventContextHash({ ...election, elgamalPubKey: null }), /public key/);
});

const contextHash = 'ab'.repeat(32);
const hex = value => value.toString(16).padStart(64, '0');
const record = (blockNumber, transactionIndex, committedAt, marker) => ({
  position: { blockNumber, transactionIndex },
  committedAt,
  commitmentNonce: hex(1000 + marker),
  receiptNonce: hex(2000 + marker),
  selectionKey: hex(3000 + marker),
  ballotArtifact: {
    nullifierHash: hex(3000 + marker),
    ciphertextVector: [{ c1: '2', c2: String(3 + marker) }],
    validityProof: { marker },
  },
});

test('stable cast-event producer is deterministic, epoch-batched and omits linking metadata', () => {
  const records = [record(7, 2, 1_800, 1), record(7, 5, 1_899, 2), record(8, 0, 2_100, 3)];
  const first = createCastEventHistory({ contextHash, records, epochSeconds: 300 });
  const second = createCastEventHistory({ contextHash, records: structuredClone(records), epochSeconds: 300 });
  assert.deepEqual(second, first);
  assert.deepEqual(first.events.map(event => event.acceptedAtEpoch), [6, 6, 7]);
  assert.deepEqual(first.events.map(event => event.eventIndex), [1, 2, 3]);
  for (const event of first.events) {
    assert.deepEqual(Object.keys(event).sort(), [
      'acceptedAtEpoch', 'electionContextHash', 'eventCommitment', 'eventID', 'eventIndex',
      'producerPreviousEventHash', 'receiptHash', 'schema',
    ]);
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /nullifier|supersession|revote|evict|committedAt|blockNumber|transactionIndex/i);
  }
  assert.equal(verifyCastEventHistory(first), true);
});

test('opaque event commitments cannot be matched to canonical active ballots without private nonce', () => {
  const source = record(1, 0, 300, 9);
  const history = createCastEventHistory({ contextHash, records: [source], epochSeconds: 300 });
  assert.notEqual(history.events[0].eventCommitment,
    require('../src/verify').sha256Hex(require('../src/verify').canonicalize(source.ballotArtifact)));
  const changedNonce = structuredClone(source);
  changedNonce.commitmentNonce = hex(9999);
  assert.notEqual(createCastEventHistory({ contextHash, records: [changedNonce], epochSeconds: 300 }).events[0].eventCommitment,
    history.events[0].eventCommitment);
});

test('producer rejects unstable positions, gaps in supplied cast sequence and malformed private inputs', () => {
  assert.throws(() => createCastEventHistory({ contextHash, records: [record(2, 0, 300, 1), record(1, 0, 300, 2)] }), /strictly increasing/);
  assert.throws(() => createCastEventHistory({ contextHash, records: [record(1, 0, 300, 1), record(1, 0, 301, 2)] }), /strictly increasing/);
  const malformed = record(1, 0, 300, 1);
  malformed.commitmentNonce = '00';
  assert.throws(() => createCastEventHistory({ contextHash, records: [malformed] }), /commitmentNonce/);
});

test('history detects deletion, reorder, replacement, context transplant and chain mutation', () => {
  const history = createCastEventHistory({ contextHash, records: [record(1, 0, 300, 1), record(1, 1, 301, 2), record(2, 0, 600, 3)] });
  const mutations = [
    value => { value.events.pop(); },
    value => { value.events.reverse(); },
    value => { value.events[1] = structuredClone(value.events[0]); },
    value => { value.electionContextHash = 'cd'.repeat(32); },
    value => { value.events[1].producerPreviousEventHash = 'ef'.repeat(32); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(history);
    mutate(changed);
    assert.throws(() => verifyCastEventHistory(changed));
  }
});

test('history extension preserves the old prefix and produces a consistency proof', () => {
  const records = [record(1, 0, 300, 1), record(1, 1, 301, 2), record(2, 0, 600, 3)];
  const prefix = createCastEventHistory({ contextHash, records: records.slice(0, 2) });
  const extended = createCastEventHistory({ contextHash, records, previousHistory: prefix });
  assert.deepEqual(extended.events.slice(0, prefix.events.length), prefix.events);
  assert.equal(extended.previousTreeSize, 2);
  assert.equal(extended.previousRootHash, prefix.rootHash);
  assert.ok(extended.consistencyPath.length > 0);
  assert.equal(verifyCastEventHistory(extended, prefix), true);
  const replaced = structuredClone(extended);
  replaced.events[0].receiptHash = 'ff'.repeat(32);
  assert.throws(() => verifyCastEventHistory(replaced, prefix));
});

test('private selection manifest opens every opaque event and selects only the latest event per private class', () => {
  const first = record(1, 0, 300, 1);
  const replacement = record(1, 1, 301, 2);
  replacement.selectionKey = first.selectionKey;
  const independent = record(2, 0, 600, 3);
  const records = [first, replacement, independent];
  const history = createCastEventHistory({ contextHash, records });
  const manifest = createPrivateSelectionManifest({ history, records });
  assert.deepEqual(manifest.selections.map(item => item.selectedEventIndex), [2, 3]);
  assert.equal(verifyPrivateSelectionManifest(history, manifest), true);
  assert.doesNotMatch(JSON.stringify(history), new RegExp(first.selectionKey));

  const stale = structuredClone(manifest);
  stale.selections[0].selectedEventIndex = 1;
  stale.selections[0].selectedEventID = history.events[0].eventID;
  assert.throws(() => verifyPrivateSelectionManifest(history, stale), /latest/);
  const missing = structuredClone(manifest);
  missing.records.pop();
  assert.throws(() => verifyPrivateSelectionManifest(history, missing), /record count/);
  const badOpening = structuredClone(manifest);
  badOpening.records[0].commitmentNonce = hex(9999);
  assert.throws(() => verifyPrivateSelectionManifest(history, badOpening), /commitment opening/);
});
