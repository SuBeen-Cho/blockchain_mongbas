'use strict';

const ACCEPTED_EVENT_NAME = 'MongbasCastAccepted';
const ACCEPTED_EVENT_SCHEMA = 'mongbas-cast-accepted-notice/v1';
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
      const notice = JSON.parse(Buffer.from(event.getPayload_asU8()).toString('utf8'));
      exactKeys(notice, ['schema', 'electionID'], 'cast accepted notice');
      if (notice.schema !== ACCEPTED_EVENT_SCHEMA || typeof notice.electionID !== 'string' || notice.electionID.length === 0) {
        throw new Error('cast accepted notice: invalid schema or election');
      }
      result.push({ blockNumber, transactionIndex, transactionID: txID, electionID: notice.electionID });
    });
  });
  return result;
}

function privateRecordToProducerRecord(source, encoded) {
  const record = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
  exactKeys(record, ['schema', 'electionID', 'transactionID', 'committedAt', 'commitmentNonce', 'receiptNonce',
    'selectionKey', 'ballotArtifact'], 'private cast record');
  if (record.schema !== PRIVATE_RECORD_SCHEMA || record.transactionID !== source.transactionID ||
      record.electionID !== source.electionID || !Number.isSafeInteger(record.committedAt) || record.committedAt < 0 ||
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
      if (source.electionID !== electionID) continue;
      const encoded = await contract.evaluateTransaction('GetPrivateCastEvent', source.transactionID);
      const bytes = Buffer.from(encoded);
      if (bytes.length > maxRecordBytes) throw new Error('private cast record exceeds byte limit');
      if (records.length >= maxRecords) throw new Error('cast history record count exceeds limit');
      records.push(privateRecordToProducerRecord(source, bytes.toString('utf8')));
    }
    if (blockNumber === endBlock) break;
  }
  return records;
}

module.exports = { ACCEPTED_EVENT_NAME, extractAcceptedCastEvents, privateRecordToProducerRecord, collectCastHistoryRecords };
