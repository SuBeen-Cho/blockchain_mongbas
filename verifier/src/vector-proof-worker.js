'use strict';

const { parentPort } = require('node:worker_threads');
const { vectorParallelInternals } = require('./verify');

if (!parentPort) throw new Error('vector proof worker requires a parent port');

parentPort.on('message', (task) => {
  const { index, ballot, publicKeyYHex, candidateCount } = task;
  let error = null;
  try {
    vectorParallelInternals.verifyVectorBallotProof(BigInt(`0x${publicKeyYHex}`), ballot, candidateCount);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'non-Error proof failure';
  }
  parentPort.postMessage({ index, error });
});
