#!/usr/bin/env node

'use strict';

const path = require('node:path');
const { verifyBundleBytes } = require('../src/verify');
const { MAX_BUNDLE_BYTES, readBoundedRegularFile } = require('../src/input');

function fail(message, details = []) {
  console.error(`INVALID: ${message}`);
  for (const detail of details) console.error(`- ${detail}`);
  process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
  console.error('Usage: mongbas-verify <canonical-election-bundle.json>');
  process.exit(args.length === 1 ? 0 : 2);
}

try {
  const file = path.resolve(args[0]);
  const result = verifyBundleBytes(readBoundedRegularFile(file, 'election bundle', MAX_BUNDLE_BYTES));
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
