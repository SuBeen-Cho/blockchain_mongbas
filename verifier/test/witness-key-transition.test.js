'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createOpeningCheckpoint } = require('../src/witness');
const { createWitnessKeyTransition, transitionHash, validateWitnessKeyTransition } = require('../src/witness-key-transition');

function pem(pair) { return pair.privateKey.export({ format: 'pem', type: 'pkcs8' }); }

test('witness transition is bound to predecessor, context and both Ed25519 keys', () => {
  const oldPair = crypto.generateKeyPairSync('ed25519'), newPair = crypto.generateKeyPairSync('ed25519');
  const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'a'.repeat(64),
    epochSeconds: 300, witnessID: 'observer', privateKeyPem: pem(oldPair), observedAt: '2026-09-04T00:00:00.000Z' });
  const transition = createWitnessKeyTransition({ previousCheckpoint: opening, oldPrivateKeyPem: pem(oldPair),
    newPrivateKeyPem: pem(newPair), authorizedAt: '2026-09-04T00:01:00.000Z' });
  assert.equal(validateWitnessKeyTransition(transition, { effectiveSequence: 2,
    previousCheckpointHash: require('../src/witness').checkpointHash(opening) }), true);
  assert.match(transitionHash(transition), /^[0-9a-f]{64}$/);
  for (const field of ['electionContextHash', 'epochSeconds', 'effectiveSequence', 'previousCheckpointHash', 'authorizedAt']) {
    const mutated = structuredClone(transition);
    if (field === 'epochSeconds') mutated[field]++;
    else if (field === 'effectiveSequence') mutated[field]++;
    else if (field === 'authorizedAt') mutated[field] = '2026-09-04T00:02:00.000Z';
    else mutated[field] = (mutated[field][0] === 'a' ? 'b' : 'a') + mutated[field].slice(1);
    assert.throws(() => validateWitnessKeyTransition(mutated), /verification failed/);
  }
});

test('transition rejects unilateral rotation and wrong predecessor key', () => {
  const oldPair = crypto.generateKeyPairSync('ed25519'), newPair = crypto.generateKeyPairSync('ed25519');
  const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'a'.repeat(64),
    witnessID: 'observer', privateKeyPem: pem(oldPair) });
  const transition = createWitnessKeyTransition({ previousCheckpoint: opening, oldPrivateKeyPem: pem(oldPair),
    newPrivateKeyPem: pem(newPair) });
  transition.newSignature = transition.oldSignature;
  assert.throws(() => validateWitnessKeyTransition(transition), /verification failed/);
  const unrelated = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => createWitnessKeyTransition({ previousCheckpoint: opening, oldPrivateKeyPem: pem(unrelated),
    newPrivateKeyPem: pem(newPair) }), /does not sign/);
});

test('witness CLI writes separate transition and trust-v2 artifacts without overwriting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-key-transition-'));
  try {
    const oldPair = crypto.generateKeyPairSync('ed25519'), newPair = crypto.generateKeyPairSync('ed25519');
    const oldPath = path.join(directory, 'old.pem'), newPath = path.join(directory, 'new.pem');
    const logPath = path.join(directory, 'log.jsonl'), trustPath = path.join(directory, 'trust-v2.json');
    const transitionPath = path.join(directory, 'transition.json');
    fs.writeFileSync(oldPath, pem(oldPair), { mode: 0o600 });
    fs.writeFileSync(newPath, pem(newPair), { mode: 0o600 });
    const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'a'.repeat(64),
      witnessID: 'observer', privateKeyPem: pem(oldPair) });
    fs.writeFileSync(logPath, `${require('../src/verify').canonicalize(opening)}\n`, { mode: 0o600 });
    const cli = path.join(__dirname, '../bin/mongbas-witness.js');
    const args = ['authorize-cast-history-key', logPath, oldPath, newPath, trustPath, transitionPath];
    const first = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
    assert.equal(trust.schema, 'mongbas-witness-trust/v2');
    assert.equal(validateWitnessKeyTransition(JSON.parse(fs.readFileSync(transitionPath, 'utf8'))), true);
    const second = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('witness CLI atomically publishes a key-policy directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-key-policy-'));
  try {
    const oldPair = crypto.generateKeyPairSync('ed25519'), newPair = crypto.generateKeyPairSync('ed25519');
    const oldPath = path.join(directory, 'old.pem'), newPath = path.join(directory, 'new.pem');
    const logPath = path.join(directory, 'log.jsonl'), policyPath = path.join(directory, 'policy-v2');
    fs.writeFileSync(oldPath, pem(oldPair), { mode: 0o600 });
    fs.writeFileSync(newPath, pem(newPair), { mode: 0o600 });
    const opening = createOpeningCheckpoint({ electionID: 'election-a', electionContextHash: 'a'.repeat(64),
      witnessID: 'observer', privateKeyPem: pem(oldPair) });
    fs.writeFileSync(logPath, `${require('../src/verify').canonicalize(opening)}\n`, { mode: 0o600 });
    const cli = path.join(__dirname, '../bin/mongbas-witness.js');
    const args = ['authorize-cast-history-key-policy', logPath, oldPath, newPath, policyPath];
    const first = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(fs.readdirSync(policyPath).sort(), ['transition.json', 'trust.json']);
    const trust = JSON.parse(fs.readFileSync(path.join(policyPath, 'trust.json'), 'utf8'));
    assert.equal(trust.witnesses[0].transitions.length, 1);
    assert.equal(validateWitnessKeyTransition(JSON.parse(fs.readFileSync(path.join(policyPath, 'transition.json'), 'utf8'))), true);
    const second = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refusing to overwrite/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
