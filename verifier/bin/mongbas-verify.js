#!/usr/bin/env node

'use strict';

const path = require('node:path');
const { verifyBundleBytes } = require('../src/verify');
const { verifyBundleBytesParallel, validateProofWorkerCount } = require('../src/parallel');
const { MAX_BUNDLE_BYTES, readBoundedRegularFile } = require('../src/input');

function fail(message, details = []) {
  console.error(`INVALID: ${message}`);
  for (const detail of details) console.error(`- ${detail}`);
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.error('Usage: mongbas-verify [--proof-workers N] <canonical-election-bundle.json>');
    return;
  }
  let workerCount;
  let input;
  if (args.length === 1) [input] = args;
  else if (args.length === 3 && args[0] === '--proof-workers') {
    try {
      if (!/^(0|[1-9][0-9]*)$/.test(args[1])) throw new Error('proof worker count must be a canonical decimal integer');
      workerCount = Number(args[1]);
      validateProofWorkerCount(workerCount);
    } catch (error) {
      fail(error.message);
      return;
    }
    input = args[2];
  } else {
    console.error('Usage: mongbas-verify [--proof-workers N] <canonical-election-bundle.json>');
    process.exitCode = 2;
    return;
  }

  try {
    const file = path.resolve(input);
    const bytes = readBoundedRegularFile(file, 'election bundle', MAX_BUNDLE_BYTES);
    const result = workerCount === undefined ? verifyBundleBytes(bytes) : await verifyBundleBytesParallel(bytes, workerCount);
    if (!result.valid) {
      fail(result.summary, result.errors);
    } else {
      console.log(`VALID: ${result.summary}`);
      console.log(`bundleHash=${result.bundleHash}`);
      console.log(`electionID=${result.electionID}`);
      console.log(`ballots=${result.ballots}`);
      console.log(`organizationSignatures=${result.validSignatures}`);
    }
  } catch (error) {
    fail(error.message);
  }
}

main();
