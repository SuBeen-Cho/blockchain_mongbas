'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('all vector encryption randomness uniquely opens selection under the declared coercer model', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/forced-randomness-evaluation.js')],
    { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.schema, 'mongbas-forced-randomness-evaluation/v1');
  assert.equal(summary.acceptedSelectionGuesses, 1);
  assert.equal(summary.uniquelyRecoveredSelection, true);
  assert.equal(summary.castClientExportsRandomnessByDefault, false);
  assert.equal(summary.verdict, 'failed-under-declared-model');
  assert.doesNotMatch(result.stdout, /randomness"\s*:/);
});
