'use strict';

const crypto = require('node:crypto');
const { canonicalize } = require('./verify');
const {
  CHECKPOINT_V2_SCHEMA,
  CHECKPOINT_V3_SCHEMA,
  checkpointHash,
  publicKeyDer,
  verifyCheckpointLog,
} = require('./witness');

const COMPLAINT_SCHEMA = 'mongbas-witness-fork-complaint/v1';
const MONITOR_TRUST_SCHEMA = 'mongbas-complaint-monitor-trust/v1';
const COMPLAINT_KEYS = ['schema', 'reason', 'detectedAt', 'monitorID', 'monitorPublicKeyDer', 'checkpointSchema',
  'electionID', 'contextHash', 'treeSize', 'evidence', 'signature'];
const EVIDENCE_KEYS = ['witnessID', 'checkpointHash', 'rootHash'];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label}: unexpected or missing fields`);
  }
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      Buffer.from(value, 'base64').toString('base64') !== value) throw new Error(`${label}: invalid canonical base64`);
  return Buffer.from(value, 'base64');
}

function unsignedComplaint(complaint) {
  const value = structuredClone(complaint);
  delete value.signature;
  return value;
}

function checkpointContext(checkpoint) {
  return checkpoint.schema === CHECKPOINT_V3_SCHEMA ? checkpoint.electionContextHash : checkpoint.history.contextHash;
}

function findIndependentSplitView(logs, witnessTrust) {
  if (!Array.isArray(logs) || logs.length !== 2 || logs.some(lines => !Array.isArray(lines) || lines.length === 0)) {
    throw new Error('fork complaint requires exactly two non-empty checkpoint logs');
  }
  logs.forEach(lines => verifyCheckpointLog(lines, witnessTrust));
  const identities = logs.map((lines, index) => {
    const ids = new Set(lines.map(checkpoint => checkpoint.witnessID));
    if (ids.size !== 1) throw new Error(`checkpoint log ${index + 1}: mixed witness identities`);
    return lines[0].witnessID;
  });
  if (identities[0] === identities[1]) throw new Error('fork complaint requires independent witness identities');

  const schemas = logs.map((lines, index) => {
    const schema = lines[0].schema;
    if (![CHECKPOINT_V2_SCHEMA, CHECKPOINT_V3_SCHEMA].includes(schema) ||
        lines.some(checkpoint => checkpoint.schema !== schema)) {
      throw new Error(`checkpoint log ${index + 1}: complaint requires one history checkpoint schema`);
    }
    return schema;
  });
  if (schemas[0] !== schemas[1]) throw new Error('independent witness logs use different checkpoint schema versions');

  const baseline = logs[0][0];
  const electionID = baseline.electionID;
  const contextHash = checkpointContext(baseline);
  const treeAlgorithm = baseline.history.treeAlgorithm;
  const leafAlgorithm = baseline.history.leafAlgorithm;
  for (const [logIndex, lines] of logs.entries()) {
    for (const [checkpointIndex, checkpoint] of lines.entries()) {
      if (checkpoint.electionID !== electionID || checkpointContext(checkpoint) !== contextHash ||
          checkpoint.history.treeAlgorithm !== treeAlgorithm || checkpoint.history.leafAlgorithm !== leafAlgorithm) {
        throw new Error(`checkpoint log ${logIndex + 1} checkpoint ${checkpointIndex + 1}: election or history context mismatch`);
      }
    }
  }

  const bySize = logs.map(lines => {
    const snapshots = new Map();
    lines.forEach(checkpoint => snapshots.set(checkpoint.history.treeSize, checkpoint));
    return snapshots;
  });
  const sharedSizes = [...bySize[0].keys()].filter(size => bySize[1].has(size)).sort((a, b) => a - b);
  for (const treeSize of sharedSizes) {
    const checkpoints = [bySize[0].get(treeSize), bySize[1].get(treeSize)];
    if (checkpoints[0].history.rootHash !== checkpoints[1].history.rootHash) {
      return {
        checkpointSchema: schemas[0], electionID, contextHash, treeSize,
        evidence: checkpoints.map(checkpoint => ({ witnessID: checkpoint.witnessID,
          checkpointHash: checkpointHash(checkpoint), rootHash: checkpoint.history.rootHash }))
          .sort((left, right) => left.witnessID.localeCompare(right.witnessID)),
      };
    }
  }
  throw new Error('independent witness logs have no conflicting shared history snapshot');
}

function createForkComplaint({ logs, witnessTrust, monitorID, monitorPrivateKeyPem, detectedAt = new Date().toISOString() }) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(monitorID)) throw new Error('invalid monitor ID');
  if (new Date(detectedAt).toISOString() !== detectedAt) throw new Error('invalid complaint detection time');
  const split = findIndependentSplitView(logs, witnessTrust);
  const complaint = {
    schema: COMPLAINT_SCHEMA,
    reason: 'independent-witness-split-view',
    detectedAt,
    monitorID,
    monitorPublicKeyDer: publicKeyDer(monitorPrivateKeyPem),
    ...split,
  };
  complaint.signature = crypto.sign(null, Buffer.from(canonicalize(complaint)),
    crypto.createPrivateKey(monitorPrivateKeyPem)).toString('base64');
  return complaint;
}

function validateComplaintShape(complaint) {
  exactKeys(complaint, COMPLAINT_KEYS, 'complaint');
  if (complaint.schema !== COMPLAINT_SCHEMA || complaint.reason !== 'independent-witness-split-view' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(complaint.monitorID) ||
      ![CHECKPOINT_V2_SCHEMA, CHECKPOINT_V3_SCHEMA].includes(complaint.checkpointSchema) ||
      !/^[A-Za-z0-9_.-]{1,256}$/.test(complaint.electionID) || !/^[0-9a-f]{64}$/.test(complaint.contextHash) ||
      !Number.isSafeInteger(complaint.treeSize) || complaint.treeSize < 0 ||
      new Date(complaint.detectedAt).toISOString() !== complaint.detectedAt ||
      !Array.isArray(complaint.evidence) || complaint.evidence.length !== 2) throw new Error('complaint: invalid fields');
  canonicalBase64(complaint.monitorPublicKeyDer, 'complaint.monitorPublicKeyDer');
  canonicalBase64(complaint.signature, 'complaint.signature');
  complaint.evidence.forEach((item, index) => {
    exactKeys(item, EVIDENCE_KEYS, `complaint.evidence[${index}]`);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(item.witnessID) || !/^[0-9a-f]{64}$/.test(item.checkpointHash) ||
        !/^[0-9a-f]{64}$/.test(item.rootHash)) throw new Error(`complaint.evidence[${index}]: invalid fields`);
  });
  if (complaint.evidence[0].witnessID.localeCompare(complaint.evidence[1].witnessID) >= 0) {
    throw new Error('complaint evidence must be sorted by distinct witness ID');
  }
}

function trustedMonitorKey(monitorTrust, monitorID) {
  exactKeys(monitorTrust, ['schema', 'monitors'], 'monitor trust');
  if (monitorTrust.schema !== MONITOR_TRUST_SCHEMA || !Array.isArray(monitorTrust.monitors) ||
      monitorTrust.monitors.length < 1 || monitorTrust.monitors.length > 128) throw new Error('invalid monitor trust document');
  let match = null;
  const ids = new Set();
  monitorTrust.monitors.forEach((item, index) => {
    exactKeys(item, ['id', 'ed25519PublicKeyDer'], `monitor trust entry ${index}`);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(item.id) || ids.has(item.id)) throw new Error('invalid monitor trust entry');
    ids.add(item.id);
    canonicalBase64(item.ed25519PublicKeyDer, `monitor trust entry ${index} key`);
    if (item.id === monitorID) match = item.ed25519PublicKeyDer;
  });
  if (!match) throw new Error(`untrusted monitor: ${monitorID}`);
  return match;
}

function verifyForkComplaint({ complaint, logs, witnessTrust, monitorTrust }) {
  validateComplaintShape(complaint);
  const trustedKey = trustedMonitorKey(monitorTrust, complaint.monitorID);
  if (trustedKey !== complaint.monitorPublicKeyDer) throw new Error('complaint monitor key does not match pinned trust');
  const publicKey = crypto.createPublicKey({ key: canonicalBase64(trustedKey, 'trusted monitor key'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519' || !crypto.verify(null,
    Buffer.from(canonicalize(unsignedComplaint(complaint))), publicKey,
    canonicalBase64(complaint.signature, 'complaint.signature'))) throw new Error('invalid monitor signature');

  const expected = findIndependentSplitView(logs, witnessTrust);
  const bound = {
    checkpointSchema: complaint.checkpointSchema, electionID: complaint.electionID,
    contextHash: complaint.contextHash, treeSize: complaint.treeSize, evidence: complaint.evidence,
  };
  if (canonicalize(bound) !== canonicalize(expected)) throw new Error('complaint does not bind supplied witness logs');
  return { valid: true, reason: complaint.reason, monitorID: complaint.monitorID,
    electionID: complaint.electionID, contextHash: complaint.contextHash, treeSize: complaint.treeSize,
    witnessIDs: complaint.evidence.map(item => item.witnessID) };
}

module.exports = {
  COMPLAINT_SCHEMA,
  MONITOR_TRUST_SCHEMA,
  createForkComplaint,
  findIndependentSplitView,
  verifyForkComplaint,
};
