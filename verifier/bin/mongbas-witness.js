#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, verifyBundleBytes } = require('../src/verify');
const { TRUST_SCHEMA, checkpointHash, createCheckpoint, parseCanonicalLog, publicKeyDer, verifyCheckpointLog } = require('../src/witness');

function usage(exitCode = 2) {
  console.error('Usage:');
  console.error('  mongbas-witness init-trust <witness-id> <ed25519-private.pem> <witness-trust.json>');
  console.error('  mongbas-witness observe <bundle.json> <checkpoint.jsonl> <witness-id> <ed25519-private.pem>');
  console.error('  mongbas-witness verify <checkpoint.jsonl> <witness-trust.json>');
  process.exit(exitCode);
}

function initTrust(witnessID, keyPath, trustPath) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(witnessID || '')) throw new Error('invalid witnessID');
  const encodedPublicKey = publicKeyDer(fs.readFileSync(keyPath));
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: witnessID, ed25519PublicKeyDer: encodedPublicKey }] };
  const resolvedTrust = path.resolve(trustPath);
  fs.mkdirSync(path.dirname(resolvedTrust), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(resolvedTrust, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${canonicalize(trust)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`TRUST INITIALIZED: witnessID=${witnessID}`);
  console.log(`trustPath=${resolvedTrust}`);
}

function withLogLock(logPath, action) {
  const lockPath = `${logPath}.lock`;
  let lock;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    lock = fs.openSync(lockPath, 'wx', 0o600);
    return action();
  } finally {
    if (lock !== undefined) fs.closeSync(lock);
    try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function appendAndSync(logPath, line) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  try { fs.writeSync(fd, `${line}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function observe(bundlePath, logPath, witnessID, keyPath) {
  const bundleBytes = fs.readFileSync(bundlePath);
  const verification = verifyBundleBytes(bundleBytes);
  if (!verification.valid) throw new Error(`bundle rejected: ${verification.summary}: ${verification.errors.join('; ')}`);
  const bundle = JSON.parse(bundleBytes);
  const privateKeyPem = fs.readFileSync(keyPath);
  const encodedPublicKey = publicKeyDer(privateKeyPem);
  const trust = { schema: TRUST_SCHEMA, witnesses: [{ id: witnessID, ed25519PublicKeyDer: encodedPublicKey }] };
  let checkpoint;
  const resolvedLog = path.resolve(logPath);
  withLogLock(resolvedLog, () => {
    let existing = [];
    if (fs.existsSync(resolvedLog) && fs.statSync(resolvedLog).size > 0) {
      existing = parseCanonicalLog(fs.readFileSync(resolvedLog, 'utf8'));
      verifyCheckpointLog(existing, trust);
    }
    const previous = existing.at(-1);
    checkpoint = createCheckpoint({ bundle, verification, witnessID, privateKeyPem, sequence: existing.length + 1,
      previousCheckpointHash: previous ? checkpointHash(previous) : null });
    appendAndSync(resolvedLog, canonicalize(checkpoint));
  });
  console.log(`WITNESSED: electionID=${checkpoint.electionID} sequence=${checkpoint.sequence}`);
  console.log(`checkpointHash=${checkpointHash(checkpoint)}`);
  console.log(`bundleHash=${checkpoint.bundleHash}`);
}

function verify(logPath, trustPath) {
  const entries = parseCanonicalLog(fs.readFileSync(logPath, 'utf8'));
  const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  const result = verifyCheckpointLog(entries, trust);
  console.log(`VALID: ${result.checkpoints} witnessed checkpoint(s)`);
  console.log(`latestCheckpointHash=${result.latestCheckpointHash}`);
  console.log(`latestElectionID=${result.latest.electionID}`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init-trust' && args.length === 3) initTrust(args[0], path.resolve(args[1]), path.resolve(args[2]));
  else if (command === 'observe' && args.length === 4) observe(path.resolve(args[0]), path.resolve(args[1]), args[2], path.resolve(args[3]));
  else if (command === 'verify' && args.length === 2) verify(...args.map(value => path.resolve(value)));
  else if (command === '--help' || command === '-h') usage(0);
  else usage();
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exit(1);
}
