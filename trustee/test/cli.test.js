'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { generateTransportKeyPair } = require('../src/dkg');

const cli = path.join(__dirname, '../bin/mongbas-trustee.js');

function run(parameters) {
  return spawnSync(process.execPath, [cli, ...parameters], { encoding: 'utf8' });
}

test('CLI creates private keys with 0600 and refuses overwrite or loose permissions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-trustee-cli-'));
  const privateFile = path.join(directory, 'private/key.json');
  const publicFile = path.join(directory, 'public/key.json');
  const initialized = run(['init', '--id', 'EC', '--index', '1', '--private', privateFile, '--public', publicFile]);
  assert.equal(initialized.status, 0, initialized.stderr);
  if (process.platform !== 'win32') assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
  const overwrite = run(['init', '--id', 'EC', '--index', '1', '--private', privateFile, '--public', publicFile]);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /EEXIST/);
  if (process.platform !== 'win32') {
    fs.chmodSync(privateFile, 0o644);
    const participants = path.join(directory, 'participants.json');
    fs.writeFileSync(participants, '[]');
    const result = run(['contribute', '--ceremony', 'test', '--id', 'EC', '--private', privateFile,
      '--participants', participants, '--out', path.join(directory, 'contribution.json')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mode 0600/);
  }
});

test('CLI emits a signed canonical complaint without private share material', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-trustee-complaint-'));
  const ids = ['ElectionCommissionMSP', 'PartyObserverMSP', 'CivilSocietyMSP'];
  const pairs = ids.map((id, index) => generateTransportKeyPair(id, index + 1));
  const participants = pairs.map(pair => pair.publicDescriptor);
  const participantsFile = path.join(directory, 'participants.json');
  const privateFile = path.join(directory, 'complainer.json');
  const output = path.join(directory, 'complaint.json');
  fs.writeFileSync(participantsFile, JSON.stringify(participants));
  fs.writeFileSync(privateFile, JSON.stringify(pairs[0].privateRecord), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(privateFile, 0o600);
  const result = run(['complain', '--ceremony', 'cli-complaint', '--id', ids[0], '--dealer', ids[1],
    '--reason', 'invalid-signature', '--contribution-hash', crypto.createHash('sha256').update('c').digest('hex'),
    '--evidence-hash', crypto.createHash('sha256').update('e').digest('hex'), '--private', privateFile,
    '--participants', participantsFile, '--out', output]);
  assert.equal(result.status, 0, result.stderr);
  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.schema, 'mongbas-dkg-complaint/v1');
  assert.match(artifact.complaintID, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(artifact), /scalar|privateKey|privateShare/i);
});
