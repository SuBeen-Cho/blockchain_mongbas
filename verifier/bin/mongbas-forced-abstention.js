#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { readBoundedRegularFile } = require('../src/input');
const { parseCanonicalLog, verifyCheckpointLog } = require('../src/witness');
const { evaluateExclusiveTargetWindow } = require('../src/forced-abstention');

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_TRUST_BYTES = 1024 * 1024;

try {
  const [logArgument, trustArgument, model] = process.argv.slice(2);
  if (!logArgument || !trustArgument || model !== '--exclusive-target-window' || process.argv.length !== 5) {
    console.error('usage: mongbas-forced-abstention <checkpoint-v3.jsonl> <witness-trust.json> --exclusive-target-window');
    process.exit(2);
  }
  const logText = readBoundedRegularFile(path.resolve(logArgument), 'checkpoint log', MAX_LOG_BYTES, { encoding: 'utf8' });
  const trustText = readBoundedRegularFile(path.resolve(trustArgument), 'witness trust', MAX_TRUST_BYTES, { encoding: 'utf8' });
  const checkpoints = parseCanonicalLog(logText);
  const trust = JSON.parse(trustText);
  verifyCheckpointLog(checkpoints, trust);
  process.stdout.write(`${JSON.stringify(evaluateExclusiveTargetWindow(checkpoints))}\n`);
  process.exitCode = 1;
} catch (error) {
  console.error(`INVALID: ${error.message}`);
  process.exitCode = 2;
}
