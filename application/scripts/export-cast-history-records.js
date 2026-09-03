#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { connectGateway } = require('../src/gateway');
const { collectCastHistoryRecords } = require('../src/lib/castHistoryFabric');

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function blockOption(name) {
  const value = Number(option(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative safe integer`);
  return value;
}

async function main() {
  const electionID = option('election-id');
  const output = option('output');
  const startBlock = blockOption('start-block');
  const endBlock = blockOption('end-block');
  if (!electionID || !/^[A-Za-z0-9_-]{1,128}$/.test(electionID)) throw new Error('--election-id is invalid');
  if (!output || startBlock > endBlock) throw new Error('--output is required and start-block must not exceed end-block');
  const target = path.resolve(output);
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite existing output: ${target}`);
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.tmp`);
  const { gateway, network, contract } = await connectGateway();
  let blocks;
  try {
    blocks = await network.getFilteredBlockEvents({ startBlock: BigInt(startBlock) });
    const records = await collectCastHistoryRecords({ blocks, contract, electionID, endBlock });
    const document = { schema: 'mongbas-fabric-cast-history-input/v1', electionID, startBlock, endBlock, records };
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    process.stdout.write(`${JSON.stringify({ output: target, records: records.length })}\n`);
  } finally {
    blocks?.close();
    gateway.close();
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

main().catch(error => {
  process.stderr.write(`cast history export failed: ${error.message}\n`);
  process.exitCode = 1;
});
