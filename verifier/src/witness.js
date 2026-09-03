'use strict';

const crypto = require('node:crypto');
const { canonicalize, sha256Hex, verifyBundle } = require('./verify');
const {
  HISTORY_SCHEMA,
  LEAF_ALGORITHM,
  TREE_ALGORITHM,
  createHistory,
  verifyConsistencyProof,
  verifyHistoryBinding,
} = require('./history');

const CHECKPOINT_SCHEMA = 'mongbas-bulletin-board-checkpoint/v1';
const CHECKPOINT_V2_SCHEMA = 'mongbas-bulletin-board-checkpoint/v2';
const TRUST_SCHEMA = 'mongbas-witness-trust/v1';
const CHECKPOINT_KEYS = ['schema', 'witnessID', 'witnessPublicKeyDer', 'sequence', 'previousCheckpointHash', 'observedAt',
  'electionID', 'bundleHash', 'bulletinBoardRoot', 'ballotCount', 'publishedAt', 'signature'];
const CHECKPOINT_V2_KEYS = [...CHECKPOINT_KEYS.filter(key => key !== 'signature'), 'history', 'signature'];
const HISTORY_KEYS = ['schema', 'treeAlgorithm', 'leafAlgorithm', 'contextHash', 'treeSize', 'rootHash',
  'previousTreeSize', 'previousRootHash', 'consistencyPath'];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label}: unexpected or missing fields`);
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new Error(`${label}: invalid canonical base64`);
  }
  return Buffer.from(value, 'base64');
}

function unsignedCheckpoint(checkpoint) {
  const copy = structuredClone(checkpoint);
  delete copy.signature;
  return copy;
}

function checkpointHash(checkpoint) {
  return sha256Hex(canonicalize(checkpoint));
}

function publicKeyDer(privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('witness signing key must be Ed25519');
  return crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
}

function assertVerificationMatchesBundle(bundle, verification) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('bundle: expected object');
  const recomputed = verifyBundle(bundle);
  if (!recomputed.valid) throw new Error(`cannot witness an invalid election bundle: ${recomputed.errors.join('; ')}`);
  if (!verification?.valid || verification.bundleHash !== recomputed.bundleHash ||
      verification.electionID !== recomputed.electionID || verification.ballots !== recomputed.ballots) {
    throw new Error('verification result does not match election bundle');
  }
}

function validateCommonFields(checkpoint, index) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(checkpoint.witnessID) || !/^[A-Za-z0-9_.-]{1,256}$/.test(checkpoint.electionID) ||
      !/^[0-9a-f]{64}$/.test(checkpoint.bundleHash) || !/^[0-9a-f]{64}$/.test(checkpoint.bulletinBoardRoot) ||
      !Number.isSafeInteger(checkpoint.ballotCount) || checkpoint.ballotCount < 1 || !Number.isSafeInteger(checkpoint.publishedAt) || checkpoint.publishedAt < 0 ||
      new Date(checkpoint.observedAt).toISOString() !== checkpoint.observedAt) throw new Error(`checkpoint[${index}]: invalid fields`);
}

function validateHistoryShape(history, index) {
  exactKeys(history, HISTORY_KEYS, `checkpoint[${index}].history`);
  if (history.schema !== HISTORY_SCHEMA || history.treeAlgorithm !== TREE_ALGORITHM || history.leafAlgorithm !== LEAF_ALGORITHM ||
      !/^[0-9a-f]{64}$/.test(history.contextHash) || !/^[0-9a-f]{64}$/.test(history.rootHash) ||
      !/^[0-9a-f]{64}$/.test(history.previousRootHash) || !Number.isSafeInteger(history.treeSize) || history.treeSize < 1 ||
      !Number.isSafeInteger(history.previousTreeSize) || history.previousTreeSize < 0 || history.previousTreeSize > history.treeSize ||
      !Array.isArray(history.consistencyPath)) throw new Error(`checkpoint[${index}].history: invalid fields`);
  history.consistencyPath.forEach((node, proofIndex) => {
    if (!/^[0-9a-f]{64}$/.test(node)) throw new Error(`checkpoint[${index}].history.consistencyPath[${proofIndex}]: invalid hash`);
  });
  const maxPath = Math.ceil(Math.log2(history.treeSize)) + 1;
  if (history.consistencyPath.length > maxPath) throw new Error(`checkpoint[${index}].history: too many proof nodes`);
}

function createCheckpoint({ bundle, verification, witnessID, privateKeyPem, sequence, previousCheckpointHash = null, observedAt = new Date().toISOString() }) {
  assertVerificationMatchesBundle(bundle, verification);
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(witnessID || '')) throw new Error('invalid witnessID');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid checkpoint sequence');
  if (previousCheckpointHash !== null && !/^[0-9a-f]{64}$/.test(previousCheckpointHash)) throw new Error('invalid previousCheckpointHash');
  if (new Date(observedAt).toISOString() !== observedAt) throw new Error('observedAt must be canonical ISO-8601');
  const witnessPublicKeyDer = publicKeyDer(privateKeyPem);
  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    witnessID,
    witnessPublicKeyDer,
    sequence,
    previousCheckpointHash,
    observedAt,
    electionID: verification.electionID,
    bundleHash: verification.bundleHash,
    bulletinBoardRoot: bundle.bulletinBoard.root,
    ballotCount: verification.ballots,
    publishedAt: bundle.bulletinBoard.publishedAt,
    signature: '',
  };
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  checkpoint.signature = crypto.sign(null, Buffer.from(canonicalize(unsignedCheckpoint(checkpoint))), privateKey).toString('base64');
  return checkpoint;
}

function createHistoryCheckpoint({ bundle, verification, witnessID, privateKeyPem, previousCheckpoint = null,
  migrationFromV1 = false, observedAt = new Date().toISOString() }) {
  assertVerificationMatchesBundle(bundle, verification);
  if (previousCheckpoint !== null && previousCheckpoint.schema !== CHECKPOINT_V2_SCHEMA &&
      !(migrationFromV1 && previousCheckpoint.schema === CHECKPOINT_SCHEMA)) {
    throw new Error('history checkpoint requires a v2 predecessor; use explicit migration for v1');
  }
  if (migrationFromV1 && previousCheckpoint?.schema !== CHECKPOINT_SCHEMA) throw new Error('explicit migration requires a v1 predecessor');
  const previousTreeSize = previousCheckpoint?.schema === CHECKPOINT_V2_SCHEMA ? previousCheckpoint.history.treeSize : 0;
  const history = createHistory(bundle, previousTreeSize);
  if (previousCheckpoint) {
    if (previousCheckpoint.witnessID !== witnessID || previousCheckpoint.witnessPublicKeyDer !== publicKeyDer(privateKeyPem) ||
        previousCheckpoint.electionID !== verification.electionID ||
        (previousCheckpoint.schema === CHECKPOINT_V2_SCHEMA && previousCheckpoint.history.contextHash !== history.contextHash)) {
      throw new Error('history checkpoint identity or election context changed');
    }
    if (previousCheckpoint.schema === CHECKPOINT_V2_SCHEMA && history.previousRootHash !== previousCheckpoint.history.rootHash) {
      throw new Error('bundle is not an append-only extension of prior history');
    }
    if (previousCheckpoint.schema === CHECKPOINT_SCHEMA &&
        (previousCheckpoint.bundleHash !== verification.bundleHash || previousCheckpoint.bulletinBoardRoot !== bundle.bulletinBoard.root ||
         previousCheckpoint.ballotCount !== verification.ballots || previousCheckpoint.publishedAt !== bundle.bulletinBoard.publishedAt)) {
      throw new Error('v1 migration requires the exact previously witnessed bundle snapshot');
    }
  }
  const checkpoint = {
    schema: CHECKPOINT_V2_SCHEMA,
    witnessID,
    witnessPublicKeyDer: publicKeyDer(privateKeyPem),
    sequence: previousCheckpoint ? previousCheckpoint.sequence + 1 : 1,
    previousCheckpointHash: previousCheckpoint ? checkpointHash(previousCheckpoint) : null,
    observedAt,
    electionID: verification.electionID,
    bundleHash: verification.bundleHash,
    bulletinBoardRoot: bundle.bulletinBoard.root,
    ballotCount: verification.ballots,
    publishedAt: bundle.bulletinBoard.publishedAt,
    history,
    signature: '',
  };
  validateCommonFields(checkpoint, checkpoint.sequence - 1);
  validateHistoryShape(history, checkpoint.sequence - 1);
  if (previousCheckpoint && (checkpoint.observedAt < previousCheckpoint.observedAt ||
      checkpoint.publishedAt < previousCheckpoint.publishedAt)) throw new Error('history checkpoint timestamp rollback');
  checkpoint.signature = crypto.sign(null, Buffer.from(canonicalize(unsignedCheckpoint(checkpoint))),
    crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return checkpoint;
}

function validateTrust(trust) {
  exactKeys(trust, ['schema', 'witnesses'], 'trust');
  if (trust.schema !== TRUST_SCHEMA || !Array.isArray(trust.witnesses) || trust.witnesses.length === 0) throw new Error('invalid witness trust document');
  const result = new Map();
  trust.witnesses.forEach((witness, index) => {
    exactKeys(witness, ['id', 'ed25519PublicKeyDer'], `trust.witnesses[${index}]`);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(witness.id) || result.has(witness.id)) throw new Error('invalid or duplicate trusted witness id');
    const key = crypto.createPublicKey({ key: canonicalBase64(witness.ed25519PublicKeyDer, `trust.witnesses[${index}].ed25519PublicKeyDer`), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('trusted witness key must be Ed25519');
    result.set(witness.id, { encoded: witness.ed25519PublicKeyDer, key });
  });
  return result;
}

function verifyCheckpointLog(lines, trust) {
  const trusted = validateTrust(trust);
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('checkpoint log is empty');
  let previousHash = null;
  let previous = null;
  let historyVerifiedFromSequence = null;
  lines.forEach((checkpoint, index) => {
    const isV2 = checkpoint?.schema === CHECKPOINT_V2_SCHEMA;
    exactKeys(checkpoint, isV2 ? CHECKPOINT_V2_KEYS : CHECKPOINT_KEYS, `checkpoint[${index}]`);
    if ((checkpoint.schema !== CHECKPOINT_SCHEMA && !isV2) || checkpoint.sequence !== index + 1 || checkpoint.previousCheckpointHash !== previousHash) {
      throw new Error(`checkpoint[${index}]: broken schema, sequence or hash chain`);
    }
    if (previous?.schema === CHECKPOINT_V2_SCHEMA && !isV2) throw new Error(`checkpoint[${index}]: history checkpoint downgrade`);
    validateCommonFields(checkpoint, index);
    if (isV2) validateHistoryShape(checkpoint.history, index);
    const witness = trusted.get(checkpoint.witnessID);
    if (!witness || witness.encoded !== checkpoint.witnessPublicKeyDer) throw new Error(`checkpoint[${index}]: untrusted witness key`);
    const signature = canonicalBase64(checkpoint.signature, `checkpoint[${index}].signature`);
    if (!crypto.verify(null, Buffer.from(canonicalize(unsignedCheckpoint(checkpoint))), witness.key, signature)) {
      throw new Error(`checkpoint[${index}]: invalid signature`);
    }
    if (isV2) {
      if (checkpoint.history.treeSize !== checkpoint.ballotCount) throw new Error(`checkpoint[${index}]: history size mismatch`);
      if (previous && (checkpoint.witnessID !== previous.witnessID ||
          checkpoint.witnessPublicKeyDer !== previous.witnessPublicKeyDer || checkpoint.electionID !== previous.electionID)) {
        throw new Error(`checkpoint[${index}]: history migration changed witness or election`);
      }
      if (previous && (checkpoint.observedAt < previous.observedAt || checkpoint.publishedAt < previous.publishedAt)) {
        throw new Error(`checkpoint[${index}]: timestamp rollback`);
      }
      if (previous?.schema === CHECKPOINT_V2_SCHEMA) {
        if (checkpoint.witnessID !== previous.witnessID || checkpoint.witnessPublicKeyDer !== previous.witnessPublicKeyDer ||
            checkpoint.electionID !== previous.electionID || checkpoint.history.contextHash !== previous.history.contextHash ||
            checkpoint.history.treeAlgorithm !== previous.history.treeAlgorithm || checkpoint.history.leafAlgorithm !== previous.history.leafAlgorithm) {
          throw new Error(`checkpoint[${index}]: history identity or context changed`);
        }
        if (checkpoint.history.previousTreeSize !== previous.history.treeSize ||
            checkpoint.history.previousRootHash !== previous.history.rootHash) throw new Error(`checkpoint[${index}]: history predecessor mismatch`);
      } else {
        const emptyRoot = sha256Hex('');
        if (checkpoint.history.previousTreeSize !== 0 || checkpoint.history.previousRootHash !== emptyRoot ||
            checkpoint.history.consistencyPath.length !== 0) throw new Error(`checkpoint[${index}]: invalid history start or migration`);
        if (previous?.schema === CHECKPOINT_SCHEMA &&
            (checkpoint.bundleHash !== previous.bundleHash || checkpoint.bulletinBoardRoot !== previous.bulletinBoardRoot ||
             checkpoint.ballotCount !== previous.ballotCount || checkpoint.publishedAt !== previous.publishedAt)) {
          throw new Error(`checkpoint[${index}]: v1 migration requires the exact previously witnessed bundle snapshot`);
        }
        historyVerifiedFromSequence = checkpoint.sequence;
      }
      if (!verifyConsistencyProof({
        oldSize: checkpoint.history.previousTreeSize,
        newSize: checkpoint.history.treeSize,
        oldRootHash: checkpoint.history.previousRootHash,
        newRootHash: checkpoint.history.rootHash,
        consistencyPath: checkpoint.history.consistencyPath,
      })) throw new Error(`checkpoint[${index}]: invalid history consistency proof`);
    }
    previousHash = checkpointHash(checkpoint);
    previous = checkpoint;
  });
  const result = { valid: true, checkpoints: lines.length, latestCheckpointHash: previousHash, latest: lines.at(-1) };
  if (historyVerifiedFromSequence !== null) result.historyVerifiedFromSequence = historyVerifiedFromSequence;
  return result;
}

function compareCheckpointLogs(logs, trust) {
  if (!Array.isArray(logs) || logs.length < 2) throw new Error('at least two checkpoint logs are required');
  let witnessID = null;
  let longest = null;
  const observed = new Map();
  logs.forEach((lines, logIndex) => {
    const result = verifyCheckpointLog(lines, trust);
    const ids = new Set(lines.map(checkpoint => checkpoint.witnessID));
    if (ids.size !== 1) throw new Error(`checkpoint log ${logIndex + 1}: mixed witness identities`);
    const currentID = lines[0].witnessID;
    if (witnessID === null) witnessID = currentID;
    else if (currentID !== witnessID) throw new Error('checkpoint logs use different witness identities');
    lines.forEach(checkpoint => {
      const hash = checkpointHash(checkpoint);
      const prior = observed.get(checkpoint.sequence);
      if (prior !== undefined && prior !== hash) {
        throw new Error(`witness equivocation at sequence ${checkpoint.sequence}`);
      }
      observed.set(checkpoint.sequence, hash);
    });
    if (!longest || result.checkpoints > longest.checkpoints) longest = result;
  });
  return { valid: true, witnessID, logs: logs.length, checkpoints: longest.checkpoints,
    latestCheckpointHash: longest.latestCheckpointHash };
}

function compareIndependentWitnessLogs(logs, trust) {
  if (!Array.isArray(logs) || logs.length < 2) throw new Error('at least two independent witness logs are required');
  const witnessIDs = new Set();
  const snapshots = new Map();
  let electionID = null;
  let contextHash = null;
  let treeAlgorithm = null;
  let leafAlgorithm = null;
  let largestTreeSize = 0;

  logs.forEach((lines, logIndex) => {
    verifyCheckpointLog(lines, trust);
    const ids = new Set(lines.map(checkpoint => checkpoint.witnessID));
    if (ids.size !== 1) throw new Error(`checkpoint log ${logIndex + 1}: mixed witness identities`);
    const witnessID = lines[0].witnessID;
    if (witnessIDs.has(witnessID)) throw new Error(`checkpoint log ${logIndex + 1}: witness identity is not independent`);
    witnessIDs.add(witnessID);
    if (lines.some(checkpoint => checkpoint.schema !== CHECKPOINT_V2_SCHEMA)) {
      throw new Error(`checkpoint log ${logIndex + 1}: independent comparison requires v2 history checkpoints`);
    }

    lines.forEach((checkpoint, checkpointIndex) => {
      const history = checkpoint.history;
      if (electionID === null) {
        electionID = checkpoint.electionID;
        contextHash = history.contextHash;
        treeAlgorithm = history.treeAlgorithm;
        leafAlgorithm = history.leafAlgorithm;
      } else if (checkpoint.electionID !== electionID || history.contextHash !== contextHash ||
          history.treeAlgorithm !== treeAlgorithm || history.leafAlgorithm !== leafAlgorithm) {
        throw new Error(`checkpoint log ${logIndex + 1} checkpoint ${checkpointIndex + 1}: election or history context mismatch`);
      }
      largestTreeSize = Math.max(largestTreeSize, history.treeSize);
      const prior = snapshots.get(history.treeSize);
      if (prior && prior.rootHash !== history.rootHash) {
        throw new Error(`independent witness split view at history tree size ${history.treeSize}`);
      }
      if (!prior) snapshots.set(history.treeSize, { rootHash: history.rootHash, witnesses: new Set([witnessID]) });
      else prior.witnesses.add(witnessID);
    });
  });

  const sharedTreeSizes = [...snapshots.entries()]
    .filter(([, snapshot]) => snapshot.witnesses.size > 1)
    .map(([treeSize]) => treeSize)
    .sort((left, right) => left - right);
  if (sharedTreeSizes.length === 0) throw new Error('independent witness logs have no shared history snapshot');
  return { valid: true, witnessIDs: [...witnessIDs].sort(), logs: logs.length,
    sharedSnapshots: sharedTreeSizes.length, sharedTreeSizes, largestTreeSize };
}

function parseCanonicalLog(text) {
  const rawLines = String(text).split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  if (!rawLines.length || rawLines.some(line => !line)) throw new Error('checkpoint log contains empty lines');
  return rawLines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch (error) { throw new Error(`checkpoint line ${index + 1}: invalid JSON: ${error.message}`); }
    if (canonicalize(value) !== line) throw new Error(`checkpoint line ${index + 1}: non-canonical JSON`);
    return value;
  });
}

module.exports = {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_V2_SCHEMA,
  TRUST_SCHEMA,
  checkpointHash,
  compareCheckpointLogs,
  compareIndependentWitnessLogs,
  createCheckpoint,
  createHistoryCheckpoint,
  parseCanonicalLog,
  publicKeyDer,
  verifyHistoryBinding,
  verifyCheckpointLog,
};
