#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connectGateway } = require('../src/gateway');
const { collectCastHistoryRecordsResilient } = require('../src/lib/castHistoryFabric');
const { publishFileNoReplace } = require('../src/lib/atomicFile');

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function blockOption(name) {
  const value = Number(option(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative safe integer`);
  return value;
}

function optionalPositiveInteger(name, fallback, maximum) {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`--${name} must be an integer from 1 to ${maximum}`);
  return value;
}

async function main() {
  const electionID = option('election-id');
  const output = option('output');
  const startBlock = blockOption('start-block');
  const endBlock = blockOption('end-block');
  const maxRecords = optionalPositiveInteger('max-records', 10_000, 100_000);
  const maxReconnects = optionalPositiveInteger('max-reconnects', 3, 20);
  if (!electionID || !/^[A-Za-z0-9_-]{1,128}$/.test(electionID)) throw new Error('--election-id is invalid');
  if (!output || startBlock > endBlock) throw new Error('--output is required and start-block must not exceed end-block');
  const target = path.resolve(output);
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing output: ${target}`);
  const { gateway, network, contract } = await connectGateway();
  try {
    const records = await collectCastHistoryRecordsResilient({
      openBlocks: resumeBlock => network.getFilteredBlockEvents({ startBlock: BigInt(resumeBlock) }),
      contract, electionID, startBlock, endBlock, maxRecords, maxReconnects,
    });
    const document = { schema: 'mongbas-fabric-cast-history-input/v1', electionID, startBlock, endBlock, records };
    publishFileNoReplace(target, `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output: target, records: records.length })}\n`);
  } finally {
    gateway.close();
  }
}

main().catch(error => {
  process.stderr.write(`cast history export failed: ${error.message}\n`);
  process.exitCode = 1;
});
