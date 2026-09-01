#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildUnsignedBundle, signBundle } = require('../src/bundle');
const { canonicalize } = require('../src/verify');

function usage() {
  console.error('Usage:');
  console.error('  mongbas-bundle build <source.json> <bundle.json>');
  console.error('  mongbas-bundle sign <bundle.json> <organization-id> <ed25519-private-key.pem> <signed-bundle.json>');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeCanonical(file, value) {
  fs.writeFileSync(path.resolve(file), canonicalize(value), { encoding: 'utf8', mode: 0o600 });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build' && args.length === 2) {
    writeCanonical(args[1], buildUnsignedBundle(readJson(args[0])));
  } else if (command === 'sign' && args.length === 4) {
    const privateKey = fs.readFileSync(path.resolve(args[2]));
    writeCanonical(args[3], signBundle(readJson(args[0]), args[1], privateKey));
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
