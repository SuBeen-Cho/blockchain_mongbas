#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildUnsignedBundle, signBundle } = require('../src/bundle');
const { MAX_BUNDLE_BYTES, MAX_PRIVATE_KEY_BYTES, readBoundedRegularFile } = require('../src/input');
const { canonicalize } = require('../src/verify');

function usage() {
  console.error('Usage:');
  console.error('  mongbas-bundle build <source.json> <bundle.json>');
  console.error('  mongbas-bundle sign <bundle.json> <organization-id> <ed25519-private-key.pem> <signed-bundle.json>');
}

function readJson(file) {
  return JSON.parse(readBoundedRegularFile(path.resolve(file), 'bundle source', MAX_BUNDLE_BYTES, { encoding: 'utf8' }));
}

function writeCanonical(file, value) {
  fs.writeFileSync(path.resolve(file), canonicalize(value), { encoding: 'utf8', mode: 0o600 });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build' && args.length === 2) {
    writeCanonical(args[1], buildUnsignedBundle(readJson(args[0])));
  } else if (command === 'sign' && args.length === 4) {
    const privateKey = readBoundedRegularFile(path.resolve(args[2]), 'private key', MAX_PRIVATE_KEY_BYTES);
    writeCanonical(args[3], signBundle(readJson(args[0]), args[1], privateKey));
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
