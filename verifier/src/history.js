'use strict';

const crypto = require('node:crypto');
const { canonicalize } = require('./verify');

const HISTORY_SCHEMA = 'mongbas-ballot-history/v1';
const HISTORY_CONTEXT_SCHEMA = 'mongbas-ballot-history-context/v1';
const BALLOT_COMMITMENT_SCHEMA = 'mongbas-canonical-ballot-commitment/v1';
const TREE_ALGORITHM = 'mongbas-ballot-history-tree-sha256/v1';
const LEAF_ALGORITHM = 'mongbas-canonical-ballot-commitment-sha256/v1';
const HASH_RE = /^[0-9a-f]{64}$/;

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function requireHashHex(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error(`${label}: expected lowercase SHA-256 hex`);
  return Buffer.from(value, 'hex');
}

function requireTreeSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}: expected a non-negative safe integer`);
  return value;
}

function largestPowerOfTwoBelow(value) {
  if (!Number.isSafeInteger(value) || value < 2) throw new Error('tree span must be at least two');
  let power = 1;
  while (power * 2 < value) power *= 2;
  return power;
}

function historyContextHash(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('bundle: expected object');
  const context = {
    schema: HISTORY_CONTEXT_SCHEMA,
    bundleSchema: bundle.schema,
    algorithms: bundle.algorithms,
    configuration: bundle.configuration,
    publicKey: bundle.publicKey,
    trusteePublicShares: bundle.trusteePublicShares ?? null,
    keyCeremony: bundle.keyCeremony ?? null,
  };
  return sha256(Buffer.from(canonicalize(context), 'utf8')).toString('hex');
}

function ballotCommitment(contextHash, ballot) {
  requireHashHex(contextHash, 'contextHash');
  if (!ballot || typeof ballot !== 'object' || Array.isArray(ballot)) throw new Error('ballot: expected object');
  return sha256(Buffer.from(canonicalize({
    schema: BALLOT_COMMITMENT_SCHEMA,
    contextHash,
    ballot,
  }), 'utf8'));
}

function historyCommitments(bundle) {
  if (!Array.isArray(bundle?.ballots)) throw new Error('bundle.ballots: expected array');
  const contextHash = historyContextHash(bundle);
  return { contextHash, commitments: bundle.ballots.map(ballot => ballotCommitment(contextHash, ballot)) };
}

function merkleTreeHash(commitments, start = 0, end = commitments.length, memo = new Map()) {
  if (!Array.isArray(commitments)) throw new Error('commitments: expected array');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > commitments.length) {
    throw new Error('invalid tree range');
  }
  const key = `${start}:${end}`;
  if (memo.has(key)) return memo.get(key);
  const length = end - start;
  let result;
  if (length === 0) result = sha256(Buffer.alloc(0));
  else if (length === 1) {
    const commitment = commitments[start];
    if (!Buffer.isBuffer(commitment) || commitment.length !== 32) throw new Error(`commitments[${start}]: expected 32-byte buffer`);
    result = sha256(Buffer.from([0]), commitment);
  } else {
    const split = start + largestPowerOfTwoBelow(length);
    result = sha256(Buffer.from([1]), merkleTreeHash(commitments, start, split, memo), merkleTreeHash(commitments, split, end, memo));
  }
  memo.set(key, result);
  return result;
}

function consistencySubproof(commitments, prefixSize, start, end, includeOldRoot, memo) {
  const length = end - start;
  if (prefixSize === length) return includeOldRoot ? [] : [merkleTreeHash(commitments, start, end, memo)];
  const leftLength = largestPowerOfTwoBelow(length);
  const split = start + leftLength;
  if (prefixSize <= leftLength) {
    return [...consistencySubproof(commitments, prefixSize, start, split, includeOldRoot, memo),
      merkleTreeHash(commitments, split, end, memo)];
  }
  return [...consistencySubproof(commitments, prefixSize - leftLength, split, end, false, memo),
    merkleTreeHash(commitments, start, split, memo)];
}

function createConsistencyProof(commitments, oldSize) {
  if (!Array.isArray(commitments)) throw new Error('commitments: expected array');
  requireTreeSize(oldSize, 'oldSize');
  const newSize = commitments.length;
  if (oldSize > newSize) throw new Error('oldSize cannot exceed newSize');
  if (oldSize === 0 || oldSize === newSize) return [];
  return consistencySubproof(commitments, oldSize, 0, newSize, true, new Map()).map(node => node.toString('hex'));
}

function verifyConsistencyProof({ oldSize, newSize, oldRootHash, newRootHash, consistencyPath }) {
  requireTreeSize(oldSize, 'oldSize');
  requireTreeSize(newSize, 'newSize');
  const oldRoot = requireHashHex(oldRootHash, 'oldRootHash');
  const newRoot = requireHashHex(newRootHash, 'newRootHash');
  if (!Array.isArray(consistencyPath)) throw new Error('consistencyPath: expected array');
  if (oldSize > newSize) throw new Error('oldSize cannot exceed newSize');
  const maxPath = newSize === 0 ? 0 : Math.ceil(Math.log2(newSize)) + 1;
  if (consistencyPath.length > maxPath) throw new Error('consistencyPath: too many nodes');
  const proof = consistencyPath.map((node, index) => requireHashHex(node, `consistencyPath[${index}]`));

  if (oldSize === 0) {
    return proof.length === 0 && oldRoot.equals(sha256(Buffer.alloc(0)));
  }
  if (oldSize === newSize) return proof.length === 0 && oldRoot.equals(newRoot);
  if (newSize === 0 || proof.length === 0) return false;

  let fn = BigInt(oldSize - 1);
  let sn = BigInt(newSize - 1);
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }

  let index = 0;
  let firstHash;
  let secondHash;
  if (fn === 0n) {
    firstHash = oldRoot;
    secondHash = oldRoot;
  } else {
    firstHash = proof[index];
    secondHash = proof[index];
    index += 1;
  }

  for (; index < proof.length; index += 1) {
    if (sn === 0n) return false;
    const node = proof[index];
    if ((fn & 1n) === 1n || fn === sn) {
      firstHash = sha256(Buffer.from([1]), node, firstHash);
      secondHash = sha256(Buffer.from([1]), node, secondHash);
      while (fn !== 0n && (fn & 1n) === 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      secondHash = sha256(Buffer.from([1]), secondHash, node);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && firstHash.equals(oldRoot) && secondHash.equals(newRoot);
}

function createHistory(bundle, previousSize = 0) {
  const { contextHash, commitments } = historyCommitments(bundle);
  requireTreeSize(previousSize, 'previousSize');
  if (previousSize > commitments.length) throw new Error('previousSize cannot exceed tree size');
  const memo = new Map();
  return {
    schema: HISTORY_SCHEMA,
    treeAlgorithm: TREE_ALGORITHM,
    leafAlgorithm: LEAF_ALGORITHM,
    contextHash,
    treeSize: commitments.length,
    rootHash: merkleTreeHash(commitments, 0, commitments.length, memo).toString('hex'),
    previousTreeSize: previousSize,
    previousRootHash: merkleTreeHash(commitments, 0, previousSize, memo).toString('hex'),
    consistencyPath: createConsistencyProof(commitments, previousSize),
  };
}

function verifyHistoryBinding(bundle, history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('history: expected object');
  const { contextHash, commitments } = historyCommitments(bundle);
  if (history.schema !== HISTORY_SCHEMA || history.treeAlgorithm !== TREE_ALGORITHM || history.leafAlgorithm !== LEAF_ALGORITHM) {
    throw new Error('history: unsupported schema or algorithm');
  }
  if (history.contextHash !== contextHash) throw new Error('history: election context mismatch');
  if (history.treeSize !== commitments.length) throw new Error('history: tree size does not match bundle ballots');
  if (history.rootHash !== merkleTreeHash(commitments).toString('hex')) throw new Error('history: root does not match bundle ballots');
  return true;
}

module.exports = {
  BALLOT_COMMITMENT_SCHEMA,
  HISTORY_CONTEXT_SCHEMA,
  HISTORY_SCHEMA,
  LEAF_ALGORITHM,
  TREE_ALGORITHM,
  ballotCommitment,
  createConsistencyProof,
  createHistory,
  historyCommitments,
  historyContextHash,
  largestPowerOfTwoBelow,
  merkleTreeHash,
  verifyHistoryBinding,
  verifyConsistencyProof,
};
