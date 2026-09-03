'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractAcceptedCastEvents, privateRecordToProducerRecord, collectCastHistoryRecords } = require('../src/lib/castHistoryFabric');

const hash = value => value.repeat(64);
const event = (name, _payload, chaincode = 'voting') => ({
  getChaincodeId: () => chaincode, getEventName: () => name,
  // Real filtered blocks omit chaincode-event payload bytes.
  getPayload_asU8: () => Buffer.alloc(0),
});
const tx = (id, code, events) => ({ getTxid: () => id, getTxValidationCode: () => code,
  getTransactionActions: () => ({ getChaincodeActionsList: () => events.map(item => ({ getChaincodeEvent: () => item })) }) });

test('filtered block extraction preserves the actual Fabric transaction index', () => {
  const notice = { schema: 'mongbas-cast-accepted-notice/v1', electionID: 'election-a' };
  const block = { getNumber: () => 19, getFilteredTransactionsList: () => [
    tx(hash('1'), 0, [event('other', notice)]),
    tx(hash('2'), 11, [event('MongbasCastAccepted', notice)]),
    tx(hash('3'), 0, [event('MongbasCastAccepted', notice)]),
  ] };
  assert.deepEqual(extractAcceptedCastEvents(block), [{ blockNumber: 19, transactionIndex: 2,
    transactionID: hash('3') }]);
});

test('private opening is strictly bound to its public Fabric source', () => {
  const source = { blockNumber: 19, transactionIndex: 2, transactionID: hash('3'), electionID: 'election-a' };
  const privateRecord = { schema: 'mongbas-fabric-private-cast-event/v1', electionID: 'election-a',
    transactionID: hash('3'), committedAt: 1234, commitmentNonce: hash('a'), receiptNonce: hash('b'),
    selectionKey: hash('c'), ballotArtifact: { electionID: 'election-a', nullifierHash: hash('c') } };
  const record = privateRecordToProducerRecord(source, privateRecord);
  assert.deepEqual(record.position, { blockNumber: 19, transactionIndex: 2 });
  assert.equal(record.ballotArtifact.nullifierHash, hash('c'));
  assert.throws(() => privateRecordToProducerRecord({ ...source, transactionID: hash('4') }, privateRecord), /binding/);
  assert.throws(() => privateRecordToProducerRecord(source, { ...privateRecord, receiptNonce: hash('a') }), /binding/);
});

test('bounded collector exports only the selected election and stops at the requested block', async () => {
  const notice = electionID => ({ schema: 'mongbas-cast-accepted-notice/v1', electionID });
  const block = (number, id, electionID) => ({ getNumber: () => number, getFilteredTransactionsList: () => [
    tx(id, 0, [event('MongbasCastAccepted', notice(electionID))]),
  ] });
  async function* blocks() {
    yield block(4, hash('1'), 'election-a');
    yield block(5, hash('2'), 'election-b');
    yield block(6, hash('3'), 'election-a');
  }
  const contract = { evaluateTransaction: async (_name, transactionID) => Buffer.from(JSON.stringify({
    schema: 'mongbas-fabric-private-cast-event/v1', electionID: transactionID === hash('2') ? 'election-b' : 'election-a', transactionID, committedAt: 1234,
    commitmentNonce: hash('a'), receiptNonce: hash('b'), selectionKey: hash('c'),
    ballotArtifact: { electionID: 'election-a', nullifierHash: hash('c') },
  })) };
  const records = await collectCastHistoryRecords({ blocks: blocks(), contract, electionID: 'election-a', endBlock: 5 });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].position, { blockNumber: 4, transactionIndex: 0 });
});

test('collector rejects record-count and private-response resource overflow', async () => {
  const notice = { schema: 'mongbas-cast-accepted-notice/v1', electionID: 'election-a' };
  async function* oneBlock() {
    yield { getNumber: () => 4, getFilteredTransactionsList: () => [tx(hash('1'), 0,
      [event('MongbasCastAccepted', notice)])] };
  }
  const valid = Buffer.from(JSON.stringify({ schema: 'mongbas-fabric-private-cast-event/v1', electionID: 'election-a',
    transactionID: hash('1'), committedAt: 1, commitmentNonce: hash('a'), receiptNonce: hash('b'),
    selectionKey: hash('c'), ballotArtifact: { electionID: 'election-a', nullifierHash: hash('c') } }));
  await assert.rejects(collectCastHistoryRecords({ blocks: oneBlock(), contract: { evaluateTransaction: async () => Buffer.alloc(1025) },
    electionID: 'election-a', endBlock: 4, maxRecords: 100, maxRecordBytes: 1024 }), /byte limit/);
  await assert.rejects(collectCastHistoryRecords({ blocks: oneBlock(), contract: { evaluateTransaction: async () => valid },
    electionID: 'election-a', endBlock: 4, maxRecords: 0 }), /invalid/);
});
