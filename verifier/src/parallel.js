'use strict';

const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const {
  canonicalize, verifyBundleBytes, vectorParallelInternals,
} = require('./verify');

const DEFAULT_PROOF_TASK_TIMEOUT_MS = 300_000;

function maximumProofWorkers() {
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(16, available);
}

function validateProofWorkerCount(value) {
  const maximum = maximumProofWorkers();
  if (!Number.isSafeInteger(value) || value < 2 || value > maximum) {
    throw new Error(maximum < 2
      ? 'parallel proof verification requires at least 2 available processors'
      : `proof worker count must be an integer from 2 to ${maximum}`);
  }
  return value;
}

function infrastructureFailure(message) {
  return {
    valid: false,
    summary: 'parallel proof infrastructure failed',
    errors: [`parallel proof infrastructure: ${message}`],
  };
}

async function runProofPool(prepared, workerCount, options = {}) {
  const WorkerFactory = options.WorkerFactory ?? Worker;
  const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_PROOF_TASK_TIMEOUT_MS;
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 1) throw new Error('proof task timeout must be a positive safe integer');
  const workerFile = options.workerFile ?? path.join(__dirname, 'vector-proof-worker.js');
  const ballots = prepared.ballots;
  const count = Math.min(workerCount, ballots.length);
  const proofErrors = new Array(ballots.length).fill(null);
  const workers = [];
  let nextIndex = 0;
  let completed = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const terminateAll = () => Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
    const fail = (message) => {
      if (settled) return;
      settled = true;
      for (const state of workers) clearTimeout(state.timer);
      terminateAll().finally(() => reject(new Error(message)));
    };
    const finish = () => {
      if (settled || completed !== ballots.length) return;
      settled = true;
      for (const state of workers) clearTimeout(state.timer);
      terminateAll().finally(() => resolve(proofErrors.filter(Boolean)));
    };
    const dispatch = (state) => {
      if (nextIndex >= ballots.length) return finish();
      const index = nextIndex++;
      state.expectedIndex = index;
      state.timer = setTimeout(() => fail('proof task timed out'), taskTimeoutMs);
      try {
        state.worker.postMessage({
          index,
          ballot: ballots[index],
          publicKeyYHex: prepared.y.toString(16),
          candidateCount: prepared.candidates.length,
        });
      } catch (_) {
        fail('worker creation or dispatch failed');
      }
    };

    try {
      for (let offset = 0; offset < count; offset += 1) {
        const worker = new WorkerFactory(workerFile);
        const state = { worker, expectedIndex: null, timer: null, terminating: false };
        workers.push(state);
        worker.on('message', (message) => {
          if (settled) return;
          clearTimeout(state.timer);
          if (!message || typeof message !== 'object' || Array.isArray(message) ||
              message.index !== state.expectedIndex || (message.error !== null && typeof message.error !== 'string')) {
            fail('worker returned a malformed, duplicate, or out-of-order response');
            return;
          }
          const index = state.expectedIndex;
          state.expectedIndex = null;
          if (message.error !== null) proofErrors[index] = `ballots[${index}].proof: ${message.error}`;
          completed += 1;
          dispatch(state);
        });
        worker.on('error', () => fail('worker crashed'));
        worker.on('exit', (code) => {
          if (!settled && code !== 0) fail('worker exited nonzero');
          else if (!settled && state.expectedIndex !== null) fail('worker exited before responding');
        });
      }
      for (const state of workers) dispatch(state);
    } catch (_) {
      fail('worker creation or dispatch failed');
    }
  });
}

async function verifyBundleBytesParallel(bytes, workerCount, options = {}) {
  validateProofWorkerCount(workerCount);
  const text = Buffer.from(bytes).toString('utf8');
  let bundle;
  try { bundle = JSON.parse(text); } catch (_) { return verifyBundleBytes(bytes); }
  let canonical;
  try { canonical = canonicalize(bundle); } catch (_) { return verifyBundleBytes(bytes); }
  if (text.trim() !== canonical) return verifyBundleBytes(bytes);
  if (bundle?.schema !== 'mongbas-election-bundle/v4' && bundle?.schema !== 'mongbas-election-bundle/v5') {
    return verifyBundleBytes(bytes);
  }

  const prepared = vectorParallelInternals.prepareVectorBundle(bundle);
  if (prepared.errors.length !== 0 || !prepared.y || !Array.isArray(prepared.ballots) || !Array.isArray(prepared.candidates)) {
    return vectorParallelInternals.finalizeVectorBundle(prepared, canonical, []);
  }
  try {
    const proofErrors = await runProofPool(prepared, workerCount, options);
    return vectorParallelInternals.finalizeVectorBundle(prepared, canonical, proofErrors);
  } catch (error) {
    return infrastructureFailure(error.message);
  }
}

module.exports = {
  DEFAULT_PROOF_TASK_TIMEOUT_MS,
  maximumProofWorkers,
  runProofPool,
  validateProofWorkerCount,
  verifyBundleBytesParallel,
};
