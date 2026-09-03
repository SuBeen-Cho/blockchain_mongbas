#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, verifyBundleBytes } = require('../src/verify');
const { CHECKPOINT_SCHEMA, CHECKPOINT_V2_SCHEMA, TRUST_SCHEMA, checkpointHash, compareCheckpointLogs,
  compareIndependentWitnessLogs,
  createHistoryCheckpoint, parseCanonicalLog, publicKeyDer, verifyCheckpointLog, verifyHistoryBinding } = require('../src/witness');

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_TRUST_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function readRegularFile(filePath, label, maximumBytes, { privateFile = false, encoding } = {}) {
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (before.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile()) throw new Error(`${label} must be a regular file`);
    if (current.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    if (privateFile && process.platform !== 'win32' && (current.mode & 0o077) !== 0) {
      throw new Error(`${label} permissions must not grant group or other access`);
    }
    return fs.readFileSync(fd, encoding ? { encoding } : undefined);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readBundle(filePath) {
  return readRegularFile(filePath, 'bundle', MAX_BUNDLE_BYTES);
}

function readLog(filePath) {
  return readRegularFile(filePath, 'checkpoint log', MAX_LOG_BYTES, { encoding: 'utf8' });
}

function readTrust(filePath) {
  return JSON.parse(readRegularFile(filePath, 'witness trust document', MAX_TRUST_BYTES, { encoding: 'utf8' }));
}

function readPrivateKey(filePath) {
  return readRegularFile(filePath, 'witness private key', MAX_PRIVATE_KEY_BYTES, { privateFile: true });
}

function usage(exitCode = 2) {
  console.error('Usage:');
  console.error('  mongbas-witness init-trust <witness-id> <ed25519-private.pem> <witness-trust.json>');
  console.error('  mongbas-witness observe <bundle.json> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness migrate-history <bundle.json> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness verify <checkpoint.jsonl> <witness-trust.json>');
  console.error('  mongbas-witness verify-bundle <bundle.json> <checkpoint.jsonl> <witness-trust.json> <sequence>');
  console.error('  mongbas-witness compare <witness-trust.json> <checkpoint-a.jsonl> <checkpoint-b.jsonl> [...]');
  console.error('  mongbas-witness compare-witnesses <witness-trust.json> <witness-a.jsonl> <witness-b.jsonl> [...]');
  process.exit(exitCode);
}

function initTrust(witnessID, keyPath, trustPath) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(witnessID || '')) throw new Error('invalid witnessID');
  const encodedPublicKey = publicKeyDer(readPrivateKey(keyPath));
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: witnessID, ed25519PublicKeyDer: encodedPublicKey }] };
  const resolvedTrust = path.resolve(trustPath);
  fs.mkdirSync(path.dirname(resolvedTrust), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(resolvedTrust, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, `${canonicalize(trust)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(path.dirname(resolvedTrust));
  console.log(`TRUST INITIALIZED: witnessID=${witnessID}`);
  console.log(`trustPath=${resolvedTrust}`);
}

function withLogLock(logPath, action) {
  const lockPath = `${logPath}.lock`;
  let lock;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    return action();
  } finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function appendAndSync(logPath, line) {
  const existed = fs.existsSync(logPath);
  if (existed) {
    const current = fs.lstatSync(logPath);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('checkpoint log must be a regular non-symlink file');
    if (current.size + Buffer.byteLength(line) + 1 > MAX_LOG_BYTES) throw new Error(`checkpoint log exceeds ${MAX_LOG_BYTES} bytes`);
  }
  const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
  try {
    const current = fs.fstatSync(fd);
    if (!current.isFile()) throw new Error('checkpoint log must be a regular file');
    if (current.size + Buffer.byteLength(line) + 1 > MAX_LOG_BYTES) throw new Error(`checkpoint log exceeds ${MAX_LOG_BYTES} bytes`);
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) syncDirectory(path.dirname(logPath));
}

function observe(bundlePath, logPath, witnessID, keyPath) {
  const bundleBytes = readBundle(bundlePath);
  const verification = verifyBundleBytes(bundleBytes);
  if (!verification.valid) throw new Error(`bundle rejected: ${verification.summary}: ${verification.errors.join('; ')}`);
  const bundle = JSON.parse(bundleBytes);
  const privateKeyPem = readPrivateKey(keyPath);
  const encodedPublicKey = publicKeyDer(privateKeyPem);
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: witnessID, ed25519PublicKeyDer: encodedPublicKey }] };
  let checkpoint;
  const resolvedLog = path.resolve(logPath);
  withLogLock(resolvedLog, () => {
    let existing = [];
    if (fs.existsSync(resolvedLog) && fs.lstatSync(resolvedLog).size > 0) {
      existing = parseCanonicalLog(readLog(resolvedLog));
      verifyCheckpointLog(existing, trust);
    }
    const previous = existing.at(-1) ?? null;
    if (previous?.schema === CHECKPOINT_SCHEMA) throw new Error('v1 log requires explicit migrate-history before v2 observation');
    checkpoint = createHistoryCheckpoint({ bundle, verification, witnessID, privateKeyPem, previousCheckpoint: previous });
    appendAndSync(resolvedLog, canonicalize(checkpoint));
  });
  console.log(`WITNESSED: electionID=${checkpoint.electionID} sequence=${checkpoint.sequence}`);
  console.log(`checkpointHash=${checkpointHash(checkpoint)}`);
  console.log(`bundleHash=${checkpoint.bundleHash}`);
}

function migrateHistory(bundlePath, logPath, witnessID, keyPath) {
  const bundleBytes = readBundle(bundlePath);
  const verification = verifyBundleBytes(bundleBytes);
  if (!verification.valid) throw new Error(`bundle rejected: ${verification.summary}: ${verification.errors.join('; ')}`);
  const bundle = JSON.parse(bundleBytes);
  const privateKeyPem = readPrivateKey(keyPath);
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: witnessID, ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  let checkpoint;
  const resolvedLog = path.resolve(logPath);
  withLogLock(resolvedLog, () => {
    if (!fs.existsSync(resolvedLog) || fs.lstatSync(resolvedLog).size === 0) throw new Error('migration requires a non-empty v1 log');
    const existing = parseCanonicalLog(readLog(resolvedLog));
    verifyCheckpointLog(existing, trust);
    const previous = existing.at(-1);
    if (previous.schema !== CHECKPOINT_SCHEMA) throw new Error('migration requires the latest checkpoint to be v1');
    checkpoint = createHistoryCheckpoint({ bundle, verification, witnessID, privateKeyPem,
      previousCheckpoint: previous, migrationFromV1: true });
    appendAndSync(resolvedLog, canonicalize(checkpoint));
  });
  console.log(`HISTORY MIGRATED: consistency starts at sequence=${checkpoint.sequence}`);
  console.log(`checkpointHash=${checkpointHash(checkpoint)}`);
}

function verify(logPath, trustPath) {
  const entries = parseCanonicalLog(readLog(logPath));
  const trust = readTrust(trustPath);
  const result = verifyCheckpointLog(entries, trust);
  console.log(`VALID: ${result.checkpoints} witnessed checkpoint(s)`);
  console.log(`latestCheckpointHash=${result.latestCheckpointHash}`);
  console.log(`latestElectionID=${result.latest.electionID}`);
  console.log(result.historyVerifiedFromSequence === undefined
    ? 'historyConsistency=not-available-v1-signature-chain-only'
    : `historyConsistency=verified-from-sequence-${result.historyVerifiedFromSequence}`);
}

function verifyBundleCheckpoint(bundlePath, logPath, trustPath, sequenceText) {
  if (!/^[1-9][0-9]*$/.test(sequenceText)) throw new Error('sequence must be a positive integer');
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) throw new Error('sequence exceeds safe integer range');
  const bundleBytes = readBundle(bundlePath);
  const bundleVerification = verifyBundleBytes(bundleBytes);
  if (!bundleVerification.valid) throw new Error(`bundle rejected: ${bundleVerification.summary}: ${bundleVerification.errors.join('; ')}`);
  const bundle = JSON.parse(bundleBytes);
  const entries = parseCanonicalLog(readLog(logPath));
  const trust = readTrust(trustPath);
  verifyCheckpointLog(entries, trust);
  const checkpoint = entries[sequence - 1];
  if (!checkpoint || checkpoint.sequence !== sequence) throw new Error('checkpoint sequence not found');
  if (checkpoint.schema !== CHECKPOINT_V2_SCHEMA) throw new Error('checkpoint has no v2 history binding');
  if (checkpoint.bundleHash !== bundleVerification.bundleHash || checkpoint.electionID !== bundleVerification.electionID ||
      checkpoint.ballotCount !== bundleVerification.ballots || checkpoint.bulletinBoardRoot !== bundle.bulletinBoard.root) {
    throw new Error('bundle does not match checkpoint metadata');
  }
  verifyHistoryBinding(bundle, checkpoint.history);
  console.log(`BUNDLE BOUND: sequence=${sequence} bundleHash=${bundleVerification.bundleHash}`);
}

function compare(trustPath, logPaths) {
  const trust = readTrust(trustPath);
  const logs = logPaths.map(logPath => parseCanonicalLog(readLog(logPath)));
  const result = compareCheckpointLogs(logs, trust);
  console.log(`CONSISTENT: ${result.logs} checkpoint logs for witness ${result.witnessID}`);
  console.log(`latestCheckpointHash=${result.latestCheckpointHash}`);
  console.log(`checkpoints=${result.checkpoints}`);
}

function compareWitnesses(trustPath, logPaths) {
  const trust = readTrust(trustPath);
  const logs = logPaths.map(logPath => parseCanonicalLog(readLog(logPath)));
  const result = compareIndependentWitnessLogs(logs, trust);
  console.log(`CONSISTENT: ${result.logs} independent witnesses`);
  console.log(`witnessIDs=${result.witnessIDs.join(',')}`);
  console.log(`sharedTreeSizes=${result.sharedTreeSizes.join(',')}`);
  console.log(`largestTreeSize=${result.largestTreeSize}`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init-trust' && args.length === 3) initTrust(args[0], path.resolve(args[1]), path.resolve(args[2]));
  else if (command === 'observe' && args.length === 4) observe(path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]));
  else if (command === 'migrate-history' && args.length === 4) migrateHistory(path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]));
  else if (command === 'verify' && args.length === 2) verify(...args.map(value => path.resolve(value)));
  else if (command === 'verify-bundle' && args.length === 4) verifyBundleCheckpoint(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), args[3]);
  else if (command === 'compare' && args.length >= 3) compare(path.resolve(args[0]), args.slice(1).map(value => path.resolve(value)));
  else if (command === 'compare-witnesses' && args.length >= 3) compareWitnesses(path.resolve(args[0]), args.slice(1).map(value => path.resolve(value)));
  else if (command === '--help' || command === '-h') usage(0);
  else usage();
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exit(1);
}
