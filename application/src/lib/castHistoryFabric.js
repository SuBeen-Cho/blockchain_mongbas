'use strict';

const ACCEPTED_EVENT_NAME = 'MongbasCastAccepted';
const PRIVATE_RECORD_SCHEMA = 'mongbas-fabric-private-cast-event/v1';
const HASH_RE = /^[0-9a-f]{64}$/;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) throw new Error(`${label}: fields mismatch`);
}

function extractAcceptedCastEvents(block, chaincodeName = 'voting') {
  const blockNumber = block.getNumber();
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('unsafe Fabric block number');
  const result = [];
  block.getFilteredTransactionsList().forEach((transaction, transactionIndex) => {
    if (transaction.getTxValidationCode() !== 0) return;
    const txID = transaction.getTxid();
    if (!HASH_RE.test(txID)) throw new Error(`transaction ${transactionIndex}: invalid transaction ID`);
    const actions = transaction.getTransactionActions();
    if (!actions) return;
    actions.getChaincodeActionsList().forEach(action => {
      const event = action.getChaincodeEvent();
      if (!event || event.getChaincodeId() !== chaincodeName || event.getEventName() !== ACCEPTED_EVENT_NAME) return;
      // Fabric filtered-block delivery deliberately omits the chaincode-event
      // payload. The event name and committed transaction ID identify a
      // candidate record; its election binding is authenticated by the PDC
      // opening fetched below. Mocking a payload here masked this live-Fabric
      // behavior and made the original exporter fail with an empty JSON parse.
      result.push({ blockNumber, transactionIndex, transactionID: txID });
    });
  });
  return result;
}

function privateRecordToProducerRecord(source, encoded) {
  const record = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
  exactKeys(record, ['schema', 'electionID', 'transactionID', 'committedAt', 'commitmentNonce', 'receiptNonce',
    'selectionKey', 'ballotArtifact'], 'private cast record');
  if (record.schema !== PRIVATE_RECORD_SCHEMA || record.transactionID !== source.transactionID ||
      (source.electionID !== undefined && record.electionID !== source.electionID) ||
      typeof record.electionID !== 'string' || record.electionID.length === 0 ||
      !Number.isSafeInteger(record.committedAt) || record.committedAt < 0 ||
      !HASH_RE.test(record.commitmentNonce) || !HASH_RE.test(record.receiptNonce) ||
      record.commitmentNonce === record.receiptNonce || !HASH_RE.test(record.selectionKey) ||
      !record.ballotArtifact || record.ballotArtifact.electionID !== source.electionID ||
      record.ballotArtifact.nullifierHash !== record.selectionKey) throw new Error('private cast record: source binding mismatch');
  return {
    position: { blockNumber: source.blockNumber, transactionIndex: source.transactionIndex },
    committedAt: record.committedAt,
    commitmentNonce: record.commitmentNonce,
    receiptNonce: record.receiptNonce,
    selectionKey: record.selectionKey,
    ballotArtifact: record.ballotArtifact,
  };
}

async function collectCastHistoryRecords({ blocks, contract, electionID, endBlock, maxRecords = 10_000,
  maxRecordBytes = 16 * 1024 * 1024 }) {
  if (!blocks || !contract || typeof electionID !== 'string' || electionID.length === 0 ||
      !Number.isSafeInteger(endBlock) || endBlock < 0 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 ||
      maxRecords > 100_000 || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 ||
      maxRecordBytes > 64 * 1024 * 1024) throw new Error('invalid cast history collection options');
  const records = [];
  for await (const block of blocks) {
    const blockNumber = block.getNumber();
    if (blockNumber > endBlock) break;
    for (const source of extractAcceptedCastEvents(block)) {
      const encoded = await contract.evaluateTransaction('GetPrivateCastEvent', source.transactionID);
      const bytes = Buffer.from(encoded);
      if (bytes.length > maxRecordBytes) throw new Error('private cast record exceeds byte limit');
      const privateRecord = JSON.parse(bytes.toString('utf8'));
      if (privateRecord.electionID !== electionID) continue;
      if (records.length >= maxRecords) throw new Error('cast history record count exceeds limit');
      records.push(privateRecordToProducerRecord({ ...source, electionID }, privateRecord));
    }
    if (blockNumber === endBlock) break;
  }
  return records;
}

function isTransientFabricError(error) {
  return [4, 8, 10, 13, 14].includes(error?.code) ||
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(error?.code);
}

async function collectBlockRecords({ block, contract, electionID, maxRecordBytes }) {
  const blockRecords = [];
  for (const source of extractAcceptedCastEvents(block)) {
    const encoded = await contract.evaluateTransaction('GetPrivateCastEvent', source.transactionID);
    const bytes = Buffer.from(encoded);
    if (bytes.length > maxRecordBytes) throw new Error('private cast record exceeds byte limit');
    const privateRecord = JSON.parse(bytes.toString('utf8'));
    if (privateRecord.electionID !== electionID) continue;
    blockRecords.push(privateRecordToProducerRecord({ ...source, electionID }, privateRecord));
  }
  return blockRecords;
}

async function collectCastHistoryRecordsResilient({ openBlocks, contract, electionID, startBlock, endBlock,
  maxRecords = 10_000, maxRecordBytes = 16 * 1024 * 1024, maxReconnects = 3 }) {
  if (typeof openBlocks !== 'function' || !contract || typeof electionID !== 'string' || electionID.length === 0 ||
      !Number.isSafeInteger(startBlock) || startBlock < 0 || !Number.isSafeInteger(endBlock) ||
      endBlock < startBlock || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000 ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReconnects) || maxReconnects < 0 || maxReconnects > 20) {
    throw new Error('invalid resilient cast history collection options');
  }

  const records = [];
  let nextBlock = startBlock;
  let reconnects = 0;
  while (nextBlock <= endBlock) {
    let blocks;
    try {
      blocks = await openBlocks(nextBlock);
      let reachedEnd = false;
      for await (const block of blocks) {
        const blockNumber = block.getNumber();
        if (!Number.isSafeInteger(blockNumber) || blockNumber !== nextBlock) {
          throw new Error('Fabric block gap or regression: expected ' + nextBlock + ', received ' + blockNumber);
        }
        const blockRecords = await collectBlockRecords({ block, contract, electionID, maxRecordBytes });
        if (records.length + blockRecords.length > maxRecords) {
          throw new Error('cast history record count exceeds limit');
        }
        records.push(...blockRecords);
        nextBlock = blockNumber + 1;
        if (blockNumber === endBlock) {
          reachedEnd = true;
          break;
        }
      }
      if (reachedEnd) return records;
      const error = new Error('Fabric filtered block stream ended before block ' + nextBlock);
      error.code = 14;
      throw error;
    } catch (error) {
      if (!isTransientFabricError(error) || reconnects >= maxReconnects) throw error;
      reconnects += 1;
    } finally {
      blocks?.close();
    }
  }
  return records;
}

module.exports = { ACCEPTED_EVENT_NAME, extractAcceptedCastEvents, privateRecordToProducerRecord,
  collectCastHistoryRecords, collectCastHistoryRecordsResilient, isTransientFabricError };
