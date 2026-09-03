'use strict';

const { CHECKPOINT_V3_SCHEMA } = require('./witness');

function evaluateExclusiveTargetWindow(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 2) {
    throw new Error('forced-abstention evaluation requires at least opening and closing observations');
  }
  if (checkpoints.some(checkpoint => checkpoint?.schema !== CHECKPOINT_V3_SCHEMA || !checkpoint.history)) {
    throw new Error('forced-abstention evaluation requires checkpoint-v3 history observations');
  }
  if (checkpoints.some(checkpoint => !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1 ||
      !Number.isSafeInteger(checkpoint.history.treeSize) || checkpoint.history.treeSize < 0)) {
    throw new Error('forced-abstention evaluation requires non-negative safe tree sizes and positive sequences');
  }
  const first = checkpoints[0], last = checkpoints.at(-1);
  if (first.kind !== 'opening' || first.history.treeSize !== 0) {
    throw new Error('forced-abstention evaluation must begin with a genuine empty opening');
  }
  if (checkpoints.some(checkpoint => checkpoint.electionID !== first.electionID ||
      checkpoint.electionContextHash !== first.electionContextHash)) {
    throw new Error('forced-abstention checkpoints use different election context');
  }
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (checkpoints[index].history.treeSize < checkpoints[index - 1].history.treeSize) {
      throw new Error('forced-abstention checkpoint tree size regressed');
    }
  }
  const observedDelta = last.history.treeSize - first.history.treeSize;
  return {
    schema: 'mongbas-forced-abstention-evaluation/v1',
    adversaryModel: 'exclusive-target-cast-window-with-two-valid-signed-checkpoints',
    openingSequence: first.sequence,
    closingSequence: last.sequence,
    openingTreeSize: first.history.treeSize,
    closingTreeSize: last.history.treeSize,
    exclusiveTargetWindowAssumed: true,
    observedDelta,
    inferredTargetParticipated: observedDelta > 0,
    inferredTargetCastEvents: observedDelta,
    patternedRevoteObservable: observedDelta > 1,
    deterministicClassifierAccuracy: 1,
    verdict: 'failed-under-declared-model',
    forcedAbstentionResistance: false,
    limitation: 'Participation and event-count inference are valid only when the adversary knows no other voter can create an event in the observed window. They do not identify a voter or a revote in a multi-voter or cover-traffic window.',
  };
}

module.exports = { evaluateExclusiveTargetWindow };
