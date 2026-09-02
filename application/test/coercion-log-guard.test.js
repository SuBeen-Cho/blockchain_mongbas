'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');

test('runtime logs do not expose panic ballots, nullifiers or filtered counts', () => {
  const chaincode = fs.readFileSync(path.join(repositoryRoot, 'chaincode/voting/voting.go'), 'utf8');
  const application = fs.readFileSync(path.join(repositoryRoot, 'application/src/app.js'), 'utf8');
  const logCalls = chaincode.split('\n').filter(line => /log\.Printf|log\.Println/.test(line));

  assert.equal(logCalls.some(line => /panic|PANIC|패닉/.test(line)), false,
    'chaincode logs must not classify panic ballots or reveal a panic-filter count');
  assert.equal(logCalls.some(line => /nullifierHash/.test(line)), false,
    'chaincode logs must not emit a ballot nullifier from a panic branch');
  assert.doesNotMatch(application, /Panic Mode 비밀번호\s*:/,
    'server startup logs must not advertise panic-secret configuration');
});
