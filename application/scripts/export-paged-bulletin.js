#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { connectGateway } = require('../src/gateway');
const { exportPagedBulletinToDirectory } = require('../src/lib/pagedBulletinSpool');

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || !/^[A-Za-z0-9_.-]{1,256}$/.test(argv[0]) || !path.isAbsolute(argv[1])) {
    throw new Error('usage: export-paged-bulletin <election-id> <absolute-private-output-directory>');
  }
  const [electionID, outputDirectory] = argv;
  const { gateway, contract } = await connectGateway();
  try {
    const result = await exportPagedBulletinToDirectory(contract, electionID, outputDirectory);
    process.stdout.write(`${JSON.stringify({
      schema: 'mongbas-paged-bulletin-export-summary/v1',
      electionID,
      publishedAt: result.index.publishedAt,
      indexHash: result.index.indexHash,
      ballots: result.index.ballotCount,
      receipts: result.index.receiptCount,
      disclosures: result.index.disclosureCount,
      fetchedPages: result.fetchedPages,
      reusedPages: result.reusedPages,
      output: result.output,
    })}\n`);
  } finally {
    gateway.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`paged bulletin export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
