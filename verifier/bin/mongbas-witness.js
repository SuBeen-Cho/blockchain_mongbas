#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, verifyBundleBytes } = require('../src/verify');
const { CHECKPOINT_SCHEMA, CHECKPOINT_V2_SCHEMA, CHECKPOINT_V3_SCHEMA, TRUST_SCHEMA, checkpointHash, compareCheckpointLogs,
  compareIndependentWitnessLogs,
  createHistoryCheckpoint, createOpeningCheckpoint, createCastHistoryCheckpoint,
  parseCanonicalLog, publicKeyDer, verifyCheckpointLog, verifyHistoryBinding } = require('../src/witness');
const { verifyCastEventHistory } = require('../src/cast-event-history');
const { createWitnessKeyTransition } = require('../src/witness-key-transition');
const { MONITOR_TRUST_SCHEMA, createForkComplaint, verifyForkComplaint } = require('../src/witness-complaint');

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_TRUST_BYTES = 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
const MAX_COMPLAINT_BYTES = 1024 * 1024;
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

function readCanonicalJSON(filePath, label, maximumBytes) {
  const text = readRegularFile(filePath, label, maximumBytes, { encoding: 'utf8' });
  const value = JSON.parse(text);
  if (`${canonicalize(value)}\n` !== text) throw new Error(`${label} is not canonical JSON with one trailing newline`);
  return value;
}

function readPrivateKey(filePath) {
  return readRegularFile(filePath, 'witness private key', MAX_PRIVATE_KEY_BYTES, { privateFile: true });
}

function readHistory(filePath) {
  const bytes = readRegularFile(filePath, 'cast-event history', MAX_HISTORY_BYTES);
  const text = bytes.toString('utf8');
  const history = JSON.parse(text);
  if (canonicalize(history) !== text.trim()) throw new Error('cast-event history is not canonical JSON');
  verifyCastEventHistory(history);
  return history;
}

function usage(exitCode = 2) {
  console.error('Usage:');
  console.error('  mongbas-witness init-trust <witness-id> <ed25519-private.pem> <witness-trust.json>');
  console.error('  mongbas-witness observe <bundle.json> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness migrate-history <bundle.json> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness open-cast-history <election-id> <context-hash> <epoch-seconds> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness observe-cast-history <history.json> <bundle.json> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness authorize-cast-history-key <checkpoint.jsonl> <old-private.pem> <new-private.pem> <trust-v2.json> <transition.json>');
  console.error('  mongbas-witness authorize-cast-history-key-policy <checkpoint.jsonl> <old-private.pem> <new-private.pem> <policy-directory> [previous-trust-v2.json]');
  console.error('  mongbas-witness observe-cast-history-rotated <history.json> <bundle.json> <checkpoint.jsonl> <witness-id> <new-private.pem> <trust-v2.json>');
  console.error('  mongbas-witness verify <checkpoint.jsonl> <witness-trust.json>');
  console.error('  mongbas-witness verify-bundle <bundle.json> <checkpoint.jsonl> <witness-trust.json> <sequence>');
  console.error('  mongbas-witness verify-cast-history <history.json> <checkpoint.jsonl> <witness-trust.json> <sequence>');
  console.error('  mongbas-witness compare <witness-trust.json> <checkpoint-a.jsonl> <checkpoint-b.jsonl> [...]');
  console.error('  mongbas-witness compare-witnesses <witness-trust.json> <witness-a.jsonl> <witness-b.jsonl> [...]');
  console.error('  mongbas-witness init-monitor-trust <monitor-id> <ed25519-private.pem> <monitor-trust.json>');
  console.error('  mongbas-witness complain-fork <witness-trust.json> <monitor-id> <monitor-private.pem> <complaint.json> <witness-a.jsonl> <witness-b.jsonl>');
  console.error('  mongbas-witness verify-fork <witness-trust.json> <monitor-trust.json> <complaint.json> <witness-a.jsonl> <witness-b.jsonl>');
  process.exit(exitCode);
}

function openCastHistory(electionID, contextHash, epochText, logPath, witnessID, keyPath) {
  if (!/^[1-9][0-9]*$/.test(epochText)) throw new Error('epoch-seconds must be a positive integer');
  const epochSeconds = Number(epochText);
  const privateKeyPem = readPrivateKey(keyPath);
  const checkpoint = createOpeningCheckpoint({ electionID, electionContextHash: contextHash, epochSeconds,
    witnessID, privateKeyPem });
  const resolvedLog = path.resolve(logPath);
  withLogLock(resolvedLog, () => {
    if (fs.existsSync(resolvedLog) && fs.lstatSync(resolvedLog).size > 0) throw new Error('v3 opening requires an empty checkpoint log');
    appendAndSync(resolvedLog, canonicalize(checkpoint));
  });
  console.log(`CAST HISTORY OPENED: electionID=${electionID} sequence=1`);
  console.log(`checkpointHash=${checkpointHash(checkpoint)}`);
}

function observeCastHistory(historyPath, bundlePath, logPath, witnessID, keyPath, trustPath = null) {
  const history = readHistory(historyPath);
  const bundleBytes = readBundle(bundlePath);
  const verification = verifyBundleBytes(bundleBytes);
  if (!verification.valid) throw new Error(`bundle rejected: ${verification.summary}: ${verification.errors.join('; ')}`);
  const bundle = JSON.parse(bundleBytes);
  const privateKeyPem = readPrivateKey(keyPath);
  const trust = trustPath ? readTrust(trustPath) :
    { schema: TRUST_SCHEMA, witnesses: [{ id: witnessID, ed25519PublicKeyDer: publicKeyDer(privateKeyPem) }] };
  let checkpoint;
  const resolvedLog = path.resolve(logPath);
  withLogLock(resolvedLog, () => {
    if (!fs.existsSync(resolvedLog) || fs.lstatSync(resolvedLog).size === 0) throw new Error('v3 observation requires an opening checkpoint');
    const existing = parseCanonicalLog(readLog(resolvedLog));
    verifyCheckpointLog(existing, trust);
    const previous = existing.at(-1);
    if (previous.schema !== CHECKPOINT_V3_SCHEMA) throw new Error('cast-event observation cannot migrate a v1/v2 log implicitly');
    const transition = trust.schema === 'mongbas-witness-trust/v2'
      ? trust.witnesses.find(item => item.id === witnessID)?.transitions.find(item =>
        item.effectiveSequence === previous.sequence + 1 && item.newPublicKeyDer === publicKeyDer(privateKeyPem))
      : null;
    checkpoint = createCastHistoryCheckpoint({ history, bundle, verification, witnessID, privateKeyPem,
      previousCheckpoint: previous, keyTransition: transition || null });
    appendAndSync(resolvedLog, canonicalize(checkpoint));
  });
  console.log(`CAST HISTORY WITNESSED: electionID=${checkpoint.electionID} sequence=${checkpoint.sequence}`);
  console.log(`checkpointHash=${checkpointHash(checkpoint)}`);
  console.log(`historyArtifactHash=${checkpoint.historyArtifactHash}`);
}

function writeExclusivePrivateJSON(filePath, value, label) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, `${canonicalize(value)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(resolved));
  console.log(`${label}=${resolved}`);
}

function authorizeCastHistoryKey(logPath, oldKeyPath, newKeyPath, trustPath, transitionPath) {
  if (fs.existsSync(path.resolve(trustPath)) || fs.existsSync(path.resolve(transitionPath))) {
    throw new Error('refusing to overwrite trust or transition output');
  }
  const entries = parseCanonicalLog(readLog(logPath));
  const previous = entries.at(-1);
  if (previous?.schema !== CHECKPOINT_V3_SCHEMA) throw new Error('key rotation requires a checkpoint-v3 log');
  const transition = createWitnessKeyTransition({ previousCheckpoint: previous,
    oldPrivateKeyPem: readPrivateKey(oldKeyPath), newPrivateKeyPem: readPrivateKey(newKeyPath) });
  const trust = { schema: 'mongbas-witness-trust/v2', witnesses: [{ id: previous.witnessID,
    initialEd25519PublicKeyDer: entries[0].witnessPublicKeyDer, transitions: [transition] }] };
  verifyCheckpointLog(entries, { schema: TRUST_SCHEMA, witnesses: [{ id: previous.witnessID,
    ed25519PublicKeyDer: previous.witnessPublicKeyDer }] });
  writeExclusivePrivateJSON(transitionPath, transition, 'transitionPath');
  writeExclusivePrivateJSON(trustPath, trust, 'trustPath');
}

function publishKeyPolicyDirectory(directoryPath, trust, transition) {
  const target = path.resolve(directoryPath);
  if (fs.existsSync(target)) throw new Error('refusing to overwrite key policy directory');
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.tmp.`));
  try {
    fs.chmodSync(stage, 0o700);
    for (const [name, value] of [['trust.json', trust], ['transition.json', transition]]) {
      const file = path.join(stage, name);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      try { fs.writeSync(fd, `${canonicalize(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    syncDirectory(stage);
    fs.renameSync(stage, target);
    syncDirectory(parent);
  } catch (error) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) { /* preserve original error */ }
    throw error;
  }
  console.log(`policyDirectory=${target}`);
}

function authorizeCastHistoryKeyPolicy(logPath, oldKeyPath, newKeyPath, policyDirectory, previousTrustPath = null) {
  const entries = parseCanonicalLog(readLog(logPath));
  const previous = entries.at(-1);
  if (previous?.schema !== CHECKPOINT_V3_SCHEMA) throw new Error('key rotation requires a checkpoint-v3 log');
  const oldPrivateKeyPem = readPrivateKey(oldKeyPath);
  const oldPublicKey = publicKeyDer(oldPrivateKeyPem);
  let trust;
  if (previousTrustPath) {
    trust = readTrust(previousTrustPath);
    if (trust.schema !== 'mongbas-witness-trust/v2') throw new Error('previous rotation policy must use trust v2');
    verifyCheckpointLog(entries, trust);
  } else {
    trust = { schema: 'mongbas-witness-trust/v2', witnesses: [{ id: previous.witnessID,
      initialEd25519PublicKeyDer: oldPublicKey, transitions: [] }] };
    verifyCheckpointLog(entries, { schema: TRUST_SCHEMA,
      witnesses: [{ id: previous.witnessID, ed25519PublicKeyDer: oldPublicKey }] });
  }
  if (previous.witnessPublicKeyDer !== oldPublicKey) throw new Error('old transition key is not the current checkpoint key');
  const transition = createWitnessKeyTransition({ previousCheckpoint: previous, oldPrivateKeyPem,
    newPrivateKeyPem: readPrivateKey(newKeyPath) });
  const updated = structuredClone(trust);
  const witness = updated.witnesses.find(item => item.id === previous.witnessID);
  if (!witness) throw new Error('previous trust policy does not contain the witness');
  witness.transitions.push(transition);
  // Validate the complete old log and the newly appended, future-effective transition policy.
  verifyCheckpointLog(entries, updated);
  publishKeyPolicyDirectory(policyDirectory, updated, transition);
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
  if (checkpoint.schema !== CHECKPOINT_V2_SCHEMA &&
      !(checkpoint.schema === CHECKPOINT_V3_SCHEMA && checkpoint.kind === 'observation')) {
    throw new Error('checkpoint has no bundle observation binding');
  }
  if (checkpoint.bundleHash !== bundleVerification.bundleHash || checkpoint.electionID !== bundleVerification.electionID ||
      checkpoint.ballotCount !== bundleVerification.ballots || checkpoint.bulletinBoardRoot !== bundle.bulletinBoard.root) {
    throw new Error('bundle does not match checkpoint metadata');
  }
  if (checkpoint.schema === CHECKPOINT_V2_SCHEMA) verifyHistoryBinding(bundle, checkpoint.history);
  console.log(`BUNDLE BOUND: sequence=${sequence} bundleHash=${bundleVerification.bundleHash}`);
}

function verifyCastHistoryCheckpoint(historyPath, logPath, trustPath, sequenceText) {
  if (!/^[1-9][0-9]*$/.test(sequenceText)) throw new Error('sequence must be a positive integer');
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) throw new Error('sequence exceeds safe integer range');
  const history = readHistory(historyPath);
  const entries = parseCanonicalLog(readLog(logPath));
  verifyCheckpointLog(entries, readTrust(trustPath));
  const checkpoint = entries[sequence - 1];
  if (!checkpoint || checkpoint.sequence !== sequence) throw new Error('checkpoint sequence not found');
  if (checkpoint.schema !== CHECKPOINT_V3_SCHEMA || checkpoint.kind !== 'observation') {
    throw new Error('checkpoint has no v3 cast-history observation binding');
  }
  const expectedSummary = {
    schema: history.schema, treeAlgorithm: history.treeAlgorithm, leafAlgorithm: history.leafAlgorithm,
    treeSize: history.treeSize, rootHash: history.rootHash, previousTreeSize: history.previousTreeSize,
    previousRootHash: history.previousRootHash, consistencyPath: history.consistencyPath,
  };
  if (checkpoint.historyArtifactHash !== require('../src/verify').sha256Hex(canonicalize(history)) ||
      checkpoint.electionContextHash !== history.electionContextHash || checkpoint.epochSeconds !== history.epochSeconds ||
      canonicalize(checkpoint.history) !== canonicalize(expectedSummary)) throw new Error('cast-event history does not match checkpoint');
  console.log(`CAST HISTORY BOUND: sequence=${sequence} historyArtifactHash=${checkpoint.historyArtifactHash}`);
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

function initMonitorTrust(monitorID, keyPath, trustPath) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(monitorID || '')) throw new Error('invalid monitor ID');
  const trust = { schema: MONITOR_TRUST_SCHEMA,
    monitors: [{ id: monitorID, ed25519PublicKeyDer: publicKeyDer(readPrivateKey(keyPath)) }] };
  writeExclusivePrivateJSON(trustPath, trust, 'monitorTrustPath');
}

function complainFork(witnessTrustPath, monitorID, keyPath, complaintPath, logPaths) {
  const logs = logPaths.map(logPath => parseCanonicalLog(readLog(logPath)));
  const complaint = createForkComplaint({ logs, witnessTrust: readTrust(witnessTrustPath), monitorID,
    monitorPrivateKeyPem: readPrivateKey(keyPath) });
  writeExclusivePrivateJSON(complaintPath, complaint, 'complaintPath');
  console.log(`FORK COMPLAINT CREATED: treeSize=${complaint.treeSize} witnesses=${complaint.evidence.map(item => item.witnessID).join(',')}`);
}

function verifyFork(witnessTrustPath, monitorTrustPath, complaintPath, logPaths) {
  const complaint = readCanonicalJSON(complaintPath, 'fork complaint', MAX_COMPLAINT_BYTES);
  const monitorTrust = readCanonicalJSON(monitorTrustPath, 'monitor trust document', MAX_TRUST_BYTES);
  const logs = logPaths.map(logPath => parseCanonicalLog(readLog(logPath)));
  const result = verifyForkComplaint({ complaint, logs, witnessTrust: readTrust(witnessTrustPath), monitorTrust });
  console.log(`FORK COMPLAINT VERIFIED: electionID=${result.electionID} treeSize=${result.treeSize}`);
  console.log(`monitorID=${result.monitorID}`);
  console.log(`witnessIDs=${result.witnessIDs.join(',')}`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init-trust' && args.length === 3) initTrust(args[0], path.resolve(args[1]), path.resolve(args[2]));
  else if (command === 'observe' && args.length === 4) observe(path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]));
  else if (command === 'migrate-history' && args.length === 4) migrateHistory(path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]));
  else if (command === 'open-cast-history' && args.length === 6) openCastHistory(args[0], args[1], args[2], path.resolve(args[3]), args[4], path.resolve(args[5]));
  else if (command === 'observe-cast-history' && args.length === 5) observeCastHistory(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), args[3], path.resolve(args[4]));
  else if (command === 'authorize-cast-history-key' && args.length === 5) authorizeCastHistoryKey(...args.map(value => path.resolve(value)));
  else if (command === 'authorize-cast-history-key-policy' && (args.length === 4 || args.length === 5)) authorizeCastHistoryKeyPolicy(
    path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), path.resolve(args[3]), args[4] ? path.resolve(args[4]) : null);
  else if (command === 'observe-cast-history-rotated' && args.length === 6) observeCastHistory(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), args[3], path.resolve(args[4]), path.resolve(args[5]));
  else if (command === 'verify' && args.length === 2) verify(...args.map(value => path.resolve(value)));
  else if (command === 'verify-bundle' && args.length === 4) verifyBundleCheckpoint(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), args[3]);
  else if (command === 'verify-cast-history' && args.length === 4) verifyCastHistoryCheckpoint(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]), args[3]);
  else if (command === 'compare' && args.length >= 3) compare(path.resolve(args[0]), args.slice(1).map(value => path.resolve(value)));
  else if (command === 'compare-witnesses' && args.length >= 3) compareWitnesses(path.resolve(args[0]), args.slice(1).map(value => path.resolve(value)));
  else if (command === 'init-monitor-trust' && args.length === 3) initMonitorTrust(args[0], path.resolve(args[1]), path.resolve(args[2]));
  else if (command === 'complain-fork' && args.length === 6) complainFork(path.resolve(args[0]), args[1], path.resolve(args[2]),
    path.resolve(args[3]), args.slice(4).map(value => path.resolve(value)));
  else if (command === 'verify-fork' && args.length === 5) verifyFork(path.resolve(args[0]), path.resolve(args[1]), path.resolve(args[2]),
    args.slice(3).map(value => path.resolve(value)));
  else if (command === '--help' || command === '-h') usage(0);
  else usage();
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exit(1);
}
