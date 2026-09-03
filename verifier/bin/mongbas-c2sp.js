#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createC2spSubmissionFromV3Log, createWitnessRequest, parseAndVerifySignedCheckpoint,
  verifyWitnessCosignatures } = require('../src/c2sp-adapter');
const { readBoundedRegularFile, MAX_PRIVATE_KEY_BYTES } = require('../src/input');
const { parseCanonicalLog } = require('../src/witness');

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_TRUST_BYTES = 1024 * 1024;
const MAX_NOTE_BYTES = 64 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function usage() {
  console.error('Usage: mongbas-c2sp publish <checkpoint-v3.jsonl> <witness-trust.json> <origin> <log-operator-private.pem> <state-directory> <request-output>');
  console.error('       mongbas-c2sp verify-cosignatures <cosigned-checkpoint.note> <log-trust.json> <witness-policy.json>');
  process.exit(2);
}

function readJson(file, label) {
  return JSON.parse(readBoundedRegularFile(file, label, MAX_TRUST_BYTES, { encoding: 'utf8' }));
}

function privateKey(file) {
  const before = fs.lstatSync(file);
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new Error('log operator private key permissions must not grant group or other access');
  return readBoundedRegularFile(file, 'log operator private key', MAX_PRIVATE_KEY_BYTES);
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function ensureStateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('C2SP state must be a regular non-symlink directory');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('C2SP state directory permissions must be 0700');
}

function exclusiveWrite(file, data) {
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(file));
}

function replaceState(file, data) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.checkpoint.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function publish(logFile, trustFile, origin, keyFile, stateDirectory, outputFile) {
  const resolvedState = path.resolve(stateDirectory);
  const resolvedOutput = path.resolve(outputFile);
  if (fs.existsSync(resolvedOutput)) throw new Error('request output already exists');
  ensureStateDirectory(resolvedState);
  const lockFile = path.join(resolvedState, '.publish.lock');
  const lock = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    const logText = readBoundedRegularFile(logFile, 'checkpoint-v3 log', MAX_LOG_BYTES, { encoding: 'utf8' });
    const checkpointLog = parseCanonicalLog(logText);
    const trust = JSON.parse(readBoundedRegularFile(trustFile, 'witness trust', MAX_TRUST_BYTES, { encoding: 'utf8' }));
    const keyPem = privateKey(keyFile);
    const operatorPublicDer = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ format: 'der', type: 'spki' }).toString('base64');
    const stateFile = path.join(resolvedState, 'checkpoint.note');
    const previous = fs.existsSync(stateFile)
      ? readBoundedRegularFile(stateFile, 'persisted C2SP checkpoint', MAX_NOTE_BYTES, { encoding: 'utf8' }) : null;
    const source = checkpointLog.at(-1);
    let signedCheckpoint;
    if (previous !== null) {
      const persisted = parseAndVerifySignedCheckpoint(previous, { origin, publicKeyDer: operatorPublicDer });
      if (persisted.treeSize === source.history.treeSize && persisted.rootHash === source.history.rootHash) {
        signedCheckpoint = previous;
      } else {
        signedCheckpoint = createC2spSubmissionFromV3Log({ origin, checkpointLog, trust,
          logPrivateKeyPem: keyPem, previousSignedCheckpoint: previous }).signedCheckpoint;
        replaceState(stateFile, signedCheckpoint);
      }
    } else {
      signedCheckpoint = createC2spSubmissionFromV3Log({ origin, checkpointLog, trust, logPrivateKeyPem: keyPem }).signedCheckpoint;
      replaceState(stateFile, signedCheckpoint);
    }
    const request = createWitnessRequest({ oldSize: source.history.previousTreeSize,
      consistencyPath: source.history.consistencyPath, signedCheckpoint });
    exclusiveWrite(resolvedOutput, request);
    console.log(`C2SP REQUEST READY: treeSize=${source.history.treeSize} sourceSequence=${source.sequence}`);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

function verifyCosignatures(noteFile, logTrustFile, policyFile) {
  const note = readBoundedRegularFile(noteFile, 'cosigned checkpoint', MAX_NOTE_BYTES, { encoding: 'utf8' });
  const logTrust = readJson(logTrustFile, 'C2SP log trust');
  const policy = readJson(policyFile, 'C2SP witness policy');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).sort().join('\0') !== 'quorum\0schema\0witnesses' ||
      policy.schema !== 'mongbas-c2sp-witness-policy/v1') throw new Error('unsupported C2SP witness policy');
  if (policy.witnesses.some(witness => witness?.publicKeyDer === logTrust.publicKeyDer)) {
    throw new Error('C2SP log operator and witness policy keys must be distinct');
  }
  const checkpoint = parseAndVerifySignedCheckpoint(note, logTrust);
  const result = verifyWitnessCosignatures(note, { witnesses: policy.witnesses, quorum: policy.quorum });
  console.log(`VALID C2SP CHECKPOINT: origin=${checkpoint.origin} treeSize=${checkpoint.treeSize}`);
  console.log(`WITNESS QUORUM: ${result.acceptedWitnesses.length}/${result.quorum} ids=${result.acceptedWitnesses.join(',')}`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'publish' && args.length === 6) publish(...args);
  else if (command === 'verify-cosignatures' && args.length === 3) verifyCosignatures(...args);
  else usage();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
