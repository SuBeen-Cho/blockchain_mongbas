'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
