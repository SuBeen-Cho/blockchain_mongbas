'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CHECKPOINT_V3_SCHEMA } = require('../src/witness');
const { evaluateExclusiveTargetWindow } = require('../src/forced-abstention');

function checkpoint(kind, sequence, treeSize) {
  return { schema: CHECKPOINT_V3_SCHEMA, kind, sequence, electionID: 'election-a',
    electionContextHash: 'ab'.repeat(32), history: { treeSize } };
}

test('exclusive signed-checkpoint window reveals target participation or abstention', () => {
  const cast = evaluateExclusiveTargetWindow([checkpoint('opening', 1, 0), checkpoint('observation', 2, 1)]);
  assert.equal(cast.inferredTargetParticipated, true);
  assert.equal(cast.verdict, 'failed-under-declared-model');
  assert.equal(cast.deterministicClassifierAccuracy, 1);
  assert.equal(cast.forcedAbstentionResistance, false);
  const abstained = evaluateExclusiveTargetWindow([checkpoint('opening', 1, 0), checkpoint('observation', 2, 0)]);
  assert.equal(abstained.inferredTargetParticipated, false);
  assert.throws(() => evaluateExclusiveTargetWindow([checkpoint('observation', 1, 0), checkpoint('observation', 2, 1)]),
    /genuine empty opening/);
  assert.throws(() => evaluateExclusiveTargetWindow([checkpoint('opening', 1, 0), checkpoint('observation', 2, 2),
    checkpoint('observation', 3, 1)]), /regressed/);
  const wrongContext = checkpoint('observation', 2, 1);
  wrongContext.electionContextHash = 'cd'.repeat(32);
  assert.throws(() => evaluateExclusiveTargetWindow([checkpoint('opening', 1, 0), wrongContext]),
    /different election context/);
  assert.throws(() => evaluateExclusiveTargetWindow([checkpoint('opening', 1, 0), checkpoint('observation', 2, -1)]),
    /non-negative safe tree sizes/);
});
