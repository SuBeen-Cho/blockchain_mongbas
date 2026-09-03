'use strict';

const crypto = require('node:crypto');
const { canonicalize } = require('./verify');
const { createConsistencyProof, merkleTreeHash, verifyConsistencyProof } = require('./history');

const CAST_EVENT_SCHEMA = 'mongbas-cast-event/v1';
const CAST_EVENT_CONTEXT_SCHEMA = 'mongbas-cast-event-election-context/v1';
const CAST_EVENT_HISTORY_SCHEMA = 'mongbas-cast-event-history/v1';
const CAST_EVENT_COMMITMENT_SCHEMA = 'mongbas-private-cast-event-commitment/v1';
const CAST_RECEIPT_SCHEMA = 'mongbas-cast-event-receipt/v1';
const CAST_EVENT_TREE_ALGORITHM = 'mongbas-cast-event-history-tree-sha256/v1';
const CAST_EVENT_LEAF_ALGORITHM = 'mongbas-cast-event-id-sha256/v1';
const HASH_RE = /^[0-9a-f]{64}$/;
const EVENT_KEYS = ['schema', 'electionContextHash', 'eventIndex', 'acceptedAtEpoch', 'eventCommitment',
  'receiptHash', 'producerPreviousEventHash', 'eventID'];
const HISTORY_KEYS = ['schema', 'treeAlgorithm', 'leafAlgorithm', 'electionContextHash', 'epochSeconds', 'treeSize',
  'rootHash', 'previousTreeSize', 'previousRootHash', 'consistencyPath', 'events'];
const RECORD_KEYS = ['position', 'committedAt', 'commitmentNonce', 'receiptNonce', 'selectionKey', 'ballotArtifact'];
const PRIVATE_SELECTION_SCHEMA = 'mongbas-private-active-ballot-selection/v1';
const PRIVATE_MANIFEST_KEYS = ['schema', 'electionContextHash', 'historyTreeSize', 'historyRootHash', 'records', 'selections'];
const PRIVATE_RECORD_KEYS = ['eventIndex', 'selectionKey', 'commitmentNonce', 'receiptNonce', 'ballotArtifact'];
const SELECTION_KEYS = ['selectionKey', 'selectedEventIndex', 'selectedEventID'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) throw new Error(`${label}: fields mismatch`);
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error(`${label}: expected lowercase SHA-256 hex`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}: expected non-negative safe integer`);
  return value;
}

function deriveCastEventContextHash(election) {
  if (!election || typeof election !== 'object' || Array.isArray(election)) throw new Error('election context: expected object');
  if (typeof election.electionID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(election.electionID) ||
      !['aes', 'elgamal', 'elgamal-vector-v3'].includes(election.encryptionMode) ||
      !Array.isArray(election.candidates) || election.candidates.length < 2 ||
      election.candidates.some(value => typeof value !== 'string' || value.length < 1 || value.length > 256) ||
      new Set(election.candidates).size !== election.candidates.length ||
      !Number.isSafeInteger(election.startTime) || !Number.isSafeInteger(election.endTime) || election.endTime <= election.startTime ||
      typeof election.blindingFactor !== 'string' || !HASH_RE.test(election.blindingFactor)) {
    throw new Error('election context: invalid election configuration');
  }
  const elgamal = election.encryptionMode === 'aes' ? null : election.elgamalPubKey;
  if (election.encryptionMode !== 'aes' && (!elgamal || typeof elgamal !== 'object' || Array.isArray(elgamal))) {
    throw new Error('election context: ElGamal public key is required');
  }
  const context = {
    schema: CAST_EVENT_CONTEXT_SCHEMA,
    electionID: election.electionID,
    encryptionMode: election.encryptionMode,
    candidates: structuredClone(election.candidates),
    startTime: election.startTime,
    endTime: election.endTime,
    blindingFactor: election.blindingFactor,
    elgamalPubKey: elgamal ? structuredClone(elgamal) : null,
    thresholdPublicShares: election.thresholdPublicShares == null ? null : structuredClone(election.thresholdPublicShares),
  };
  return sha256(Buffer.from(canonicalize(context), 'utf8'));
}

function unsignedEvent(event) {
  const result = structuredClone(event);
  delete result.eventID;
  return result;
}

function eventID(event) {
  return sha256(Buffer.from(canonicalize(unsignedEvent(event)), 'utf8'));
}

function deriveEventCommitment(contextHash, commitmentNonce, ballotArtifact) {
  return sha256(Buffer.from(canonicalize({
    schema: CAST_EVENT_COMMITMENT_SCHEMA,
    electionContextHash: contextHash,
    commitmentNonce,
    ballotArtifact,
  }), 'utf8'));
}

function deriveReceiptHash(contextHash, receiptNonce, eventCommitment) {
  return sha256(Buffer.from(canonicalize({
    schema: CAST_RECEIPT_SCHEMA,
    electionContextHash: contextHash,
    receiptNonce,
    eventCommitment,
  }), 'utf8'));
}

function recordPosition(record, index) {
  exactKeys(record, RECORD_KEYS, `records[${index}]`);
  exactKeys(record.position, ['blockNumber', 'transactionIndex'], `records[${index}].position`);
  return [requireNonNegativeInteger(record.position.blockNumber, `records[${index}].position.blockNumber`),
    requireNonNegativeInteger(record.position.transactionIndex, `records[${index}].position.transactionIndex`)];
}

function publicEvent(record, index, contextHash, epochSeconds, previousEventHash) {
  requireHash(record.commitmentNonce, `records[${index}].commitmentNonce`);
  requireHash(record.receiptNonce, `records[${index}].receiptNonce`);
  requireHash(record.selectionKey, `records[${index}].selectionKey`);
  requireNonNegativeInteger(record.committedAt, `records[${index}].committedAt`);
  if (!record.ballotArtifact || typeof record.ballotArtifact !== 'object' || Array.isArray(record.ballotArtifact)) {
    throw new Error(`records[${index}].ballotArtifact: expected object`);
  }
  const eventCommitment = deriveEventCommitment(contextHash, record.commitmentNonce, record.ballotArtifact);
  const event = {
    schema: CAST_EVENT_SCHEMA,
    electionContextHash: contextHash,
    eventIndex: index + 1,
    acceptedAtEpoch: Math.floor(record.committedAt / epochSeconds),
    eventCommitment,
    receiptHash: deriveReceiptHash(contextHash, record.receiptNonce, eventCommitment),
    producerPreviousEventHash: previousEventHash,
  };
  return { ...event, eventID: eventID(event) };
}

function createPrivateSelectionManifest({ history, records }) {
  verifyCastEventHistory(history);
  if (!Array.isArray(records) || records.length !== history.treeSize) throw new Error('private selection record count mismatch');
  const privateRecords = records.map((record, index) => {
    recordPosition(record, index);
    requireHash(record.selectionKey, `records[${index}].selectionKey`);
    requireHash(record.commitmentNonce, `records[${index}].commitmentNonce`);
    requireHash(record.receiptNonce, `records[${index}].receiptNonce`);
    return { eventIndex: index + 1, selectionKey: record.selectionKey, commitmentNonce: record.commitmentNonce,
      receiptNonce: record.receiptNonce, ballotArtifact: structuredClone(record.ballotArtifact) };
  });
  const latest = new Map();
  privateRecords.forEach(record => latest.set(record.selectionKey, record.eventIndex));
  const selections = [...latest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([selectionKey, selectedEventIndex]) => ({
    selectionKey,
    selectedEventIndex,
    selectedEventID: history.events[selectedEventIndex - 1].eventID,
  }));
  const manifest = { schema: PRIVATE_SELECTION_SCHEMA, electionContextHash: history.electionContextHash,
    historyTreeSize: history.treeSize, historyRootHash: history.rootHash, records: privateRecords, selections };
  verifyPrivateSelectionManifest(history, manifest);
  return manifest;
}

function verifyPrivateSelectionManifest(history, manifest) {
  verifyCastEventHistory(history);
  exactKeys(manifest, PRIVATE_MANIFEST_KEYS, 'private selection manifest');
  if (manifest.schema !== PRIVATE_SELECTION_SCHEMA || manifest.electionContextHash !== history.electionContextHash ||
      manifest.historyTreeSize !== history.treeSize || manifest.historyRootHash !== history.rootHash) {
    throw new Error('private selection manifest history binding mismatch');
  }
  if (!Array.isArray(manifest.records) || manifest.records.length !== history.treeSize) throw new Error('private selection record count mismatch');
  const latest = new Map();
  manifest.records.forEach((record, index) => {
    exactKeys(record, PRIVATE_RECORD_KEYS, `private records[${index}]`);
    if (record.eventIndex !== index + 1) throw new Error(`private records[${index}]: event index mismatch`);
    requireHash(record.selectionKey, `private records[${index}].selectionKey`);
    requireHash(record.commitmentNonce, `private records[${index}].commitmentNonce`);
    requireHash(record.receiptNonce, `private records[${index}].receiptNonce`);
    if (!record.ballotArtifact || typeof record.ballotArtifact !== 'object' || Array.isArray(record.ballotArtifact)) {
      throw new Error(`private records[${index}].ballotArtifact: expected object`);
    }
    const commitment = deriveEventCommitment(history.electionContextHash, record.commitmentNonce, record.ballotArtifact);
    if (commitment !== history.events[index].eventCommitment ||
        deriveReceiptHash(history.electionContextHash, record.receiptNonce, commitment) !== history.events[index].receiptHash) {
      throw new Error(`private records[${index}]: commitment opening mismatch`);
    }
    latest.set(record.selectionKey, index + 1);
  });
  if (!Array.isArray(manifest.selections) || manifest.selections.length !== latest.size) throw new Error('private selection class count mismatch');
  let previousKey = null;
  manifest.selections.forEach((selection, index) => {
    exactKeys(selection, SELECTION_KEYS, `selections[${index}]`);
    requireHash(selection.selectionKey, `selections[${index}].selectionKey`);
    if (previousKey !== null && selection.selectionKey <= previousKey) throw new Error('private selections must use unique sorted keys');
    const expectedIndex = latest.get(selection.selectionKey);
    if (expectedIndex === undefined || selection.selectedEventIndex !== expectedIndex ||
        selection.selectedEventID !== history.events[expectedIndex - 1].eventID) throw new Error(`selections[${index}]: latest event mismatch`);
    previousKey = selection.selectionKey;
  });
  return true;
}

function commitments(events) {
  return events.map((event, index) => Buffer.from(requireHash(event.eventID, `events[${index}].eventID`), 'hex'));
}

function createCastEventHistory({ contextHash, records, epochSeconds = 300, previousHistory = null }) {
  requireHash(contextHash, 'contextHash');
  if (!Array.isArray(records)) throw new Error('records: expected array');
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1 || epochSeconds > 86_400) throw new Error('epochSeconds: invalid');
  let priorPosition = null;
  const events = [];
  records.forEach((record, index) => {
    const position = recordPosition(record, index);
    if (priorPosition && (position[0] < priorPosition[0] ||
        (position[0] === priorPosition[0] && position[1] <= priorPosition[1]))) {
      throw new Error(`records[${index}].position: positions must be strictly increasing`);
    }
    const priorHash = events.length === 0 ? null : events.at(-1).eventID;
    events.push(publicEvent(record, index, contextHash, epochSeconds, priorHash));
    priorPosition = position;
  });
  const leaves = commitments(events);
  let previousTreeSize = 0;
  if (previousHistory) {
    verifyCastEventHistory(previousHistory);
    if (previousHistory.electionContextHash !== contextHash || previousHistory.epochSeconds !== epochSeconds) {
      throw new Error('previous history context or epoch policy mismatch');
    }
    previousTreeSize = previousHistory.treeSize;
    if (previousTreeSize > events.length || canonicalize(events.slice(0, previousTreeSize)) !== canonicalize(previousHistory.events)) {
      throw new Error('records are not an append-only extension of previous history');
    }
  }
  const history = {
    schema: CAST_EVENT_HISTORY_SCHEMA,
    treeAlgorithm: CAST_EVENT_TREE_ALGORITHM,
    leafAlgorithm: CAST_EVENT_LEAF_ALGORITHM,
    electionContextHash: contextHash,
    epochSeconds,
    treeSize: events.length,
    rootHash: merkleTreeHash(leaves).toString('hex'),
    previousTreeSize,
    previousRootHash: merkleTreeHash(leaves, 0, previousTreeSize).toString('hex'),
    consistencyPath: createConsistencyProof(leaves, previousTreeSize),
    events,
  };
  verifyCastEventHistory(history, previousHistory);
  return history;
}

function verifyCastEventHistory(history, previousHistory = null) {
  exactKeys(history, HISTORY_KEYS, 'history');
  if (history.schema !== CAST_EVENT_HISTORY_SCHEMA || history.treeAlgorithm !== CAST_EVENT_TREE_ALGORITHM ||
      history.leafAlgorithm !== CAST_EVENT_LEAF_ALGORITHM) throw new Error('history: unsupported schema or algorithms');
  requireHash(history.electionContextHash, 'history.electionContextHash');
  if (!Number.isSafeInteger(history.epochSeconds) || history.epochSeconds < 1 || history.epochSeconds > 86_400) throw new Error('history.epochSeconds: invalid');
  requireNonNegativeInteger(history.treeSize, 'history.treeSize');
  requireNonNegativeInteger(history.previousTreeSize, 'history.previousTreeSize');
  if (!Array.isArray(history.events) || history.events.length !== history.treeSize || history.previousTreeSize > history.treeSize) {
    throw new Error('history: size mismatch');
  }
  let previousEventHash = null;
  history.events.forEach((event, index) => {
    exactKeys(event, EVENT_KEYS, `events[${index}]`);
    if (event.schema !== CAST_EVENT_SCHEMA || event.electionContextHash !== history.electionContextHash ||
        event.eventIndex !== index + 1 || !Number.isSafeInteger(event.acceptedAtEpoch) || event.acceptedAtEpoch < 0 ||
        (index > 0 && event.acceptedAtEpoch < history.events[index - 1].acceptedAtEpoch)) throw new Error(`events[${index}]: invalid binding or order`);
    requireHash(event.eventCommitment, `events[${index}].eventCommitment`);
    requireHash(event.receiptHash, `events[${index}].receiptHash`);
    if (event.producerPreviousEventHash !== previousEventHash) throw new Error(`events[${index}]: broken event hash chain`);
    if (event.eventID !== eventID(event)) throw new Error(`events[${index}]: event ID mismatch`);
    previousEventHash = event.eventID;
  });
  const leaves = commitments(history.events);
  const expectedRoot = merkleTreeHash(leaves).toString('hex');
  const expectedPreviousRoot = merkleTreeHash(leaves, 0, history.previousTreeSize).toString('hex');
  if (history.rootHash !== expectedRoot || history.previousRootHash !== expectedPreviousRoot) throw new Error('history: root mismatch');
  if (!verifyConsistencyProof({ oldSize: history.previousTreeSize, newSize: history.treeSize,
    oldRootHash: history.previousRootHash, newRootHash: history.rootHash, consistencyPath: history.consistencyPath })) {
    throw new Error('history: invalid consistency proof');
  }
  if (previousHistory) {
    verifyCastEventHistory(previousHistory);
    if (previousHistory.electionContextHash !== history.electionContextHash || previousHistory.epochSeconds !== history.epochSeconds ||
        previousHistory.treeSize !== history.previousTreeSize || previousHistory.rootHash !== history.previousRootHash ||
        canonicalize(history.events.slice(0, previousHistory.treeSize)) !== canonicalize(previousHistory.events)) {
      throw new Error('history: previous snapshot mismatch');
    }
  }
  return true;
}

module.exports = {
  CAST_EVENT_CONTEXT_SCHEMA,
  CAST_EVENT_COMMITMENT_SCHEMA,
  CAST_EVENT_HISTORY_SCHEMA,
  CAST_EVENT_LEAF_ALGORITHM,
  CAST_EVENT_SCHEMA,
  CAST_EVENT_TREE_ALGORITHM,
  CAST_RECEIPT_SCHEMA,
  PRIVATE_SELECTION_SCHEMA,
  createCastEventHistory,
  createPrivateSelectionManifest,
  deriveCastEventContextHash,
  verifyCastEventHistory,
  verifyPrivateSelectionManifest,
};
