'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Fabric input CLI separates public history from private linkage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-cast-history-'));
  try {
    const input = path.join(directory, 'input.json');
    const history = path.join(directory, 'history.json');
    const manifest = path.join(directory, 'manifest.json');
    const selectionKey = 'c'.repeat(64);
    fs.writeFileSync(input, JSON.stringify({ schema: 'mongbas-fabric-cast-history-input/v1', electionID: 'election-a',
      startBlock: 1, endBlock: 1, records: [{ position: { blockNumber: 1, transactionIndex: 0 }, committedAt: 301,
        commitmentNonce: 'a'.repeat(64), receiptNonce: 'b'.repeat(64), selectionKey,
        ballotArtifact: { electionID: 'election-a', nullifierHash: selectionKey, ciphertext: 'opaque' } }] }));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/mongbas-cast-history.js'), input,
      'd'.repeat(64), '300', history, manifest], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const publicText = fs.readFileSync(history, 'utf8');
    assert.doesNotMatch(publicText, new RegExp(selectionKey));
    assert.doesNotMatch(publicText, /nullifierHash|commitmentNonce|receiptNonce/);
    assert.match(fs.readFileSync(manifest, 'utf8'), new RegExp(selectionKey));
    const overwrite = spawnSync(process.execPath, [path.join(__dirname, '../bin/mongbas-cast-history.js'), input,
      'd'.repeat(64), '300', history, manifest], { encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /refusing to overwrite/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
