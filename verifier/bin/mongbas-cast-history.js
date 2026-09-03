#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCastEventHistory, createPrivateSelectionManifest } = require('../src/cast-event-history');
const { canonicalize } = require('../src/verify');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeExclusive(file, value) {
  const target = path.resolve(file);
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing output: ${target}`);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${canonicalize(value)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function main() {
  const [inputFile, contextHash, epochText, historyFile, privateManifestFile, previousFile] = process.argv.slice(2);
  if (!inputFile || !contextHash || !epochText || !historyFile || !privateManifestFile) {
    throw new Error('usage: mongbas-cast-history <fabric-input.json> <context-hash> <epoch-seconds> <history.json> <private-manifest.json> [previous-history.json]');
  }
  const input = readJSON(path.resolve(inputFile));
  if (input.schema !== 'mongbas-fabric-cast-history-input/v1' || !Array.isArray(input.records)) throw new Error('unsupported Fabric history input');
  const epochSeconds = Number(epochText);
  const previousHistory = previousFile ? readJSON(path.resolve(previousFile)) : null;
  const history = createCastEventHistory({ contextHash, records: input.records, epochSeconds, previousHistory });
  const privateManifest = createPrivateSelectionManifest({ history, records: input.records });
  writeExclusive(historyFile, history);
  writeExclusive(privateManifestFile, privateManifest);
  process.stdout.write(`${JSON.stringify({ treeSize: history.treeSize, rootHash: history.rootHash })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`cast history build failed: ${error.message}\n`);
  process.exitCode = 1;
}
