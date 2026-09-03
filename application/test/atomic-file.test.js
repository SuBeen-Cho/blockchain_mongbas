'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { publishFileNoReplace } = require('../src/lib/atomicFile');

test('atomic publisher never replaces an output won by another producer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-atomic-output-'));
  try {
    const target = path.join(directory, 'history.json');
    publishFileNoReplace(target, 'first\n');
    assert.throws(() => publishFileNoReplace(target, 'second\n'), error => error.code === 'EEXIST');
    assert.equal(fs.readFileSync(target, 'utf8'), 'first\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ['history.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic publisher cleans its private temporary file after a publication failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-atomic-output-'));
  try {
    const target = path.join(directory, 'history.json');
    fs.writeFileSync(target, 'protected\n', { mode: 0o600 });
    assert.throws(() => publishFileNoReplace(target, 'loser\n'), error => error.code === 'EEXIST');
    assert.deepEqual(fs.readdirSync(directory), ['history.json']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'protected\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
