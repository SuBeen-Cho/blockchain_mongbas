#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { deriveCastEventContextHash } = require('../src/cast-event-history');

try {
  const [electionFile] = process.argv.slice(2);
  if (!electionFile) throw new Error('usage: mongbas-cast-context <election.json>');
  const election = JSON.parse(fs.readFileSync(path.resolve(electionFile), 'utf8'));
  process.stdout.write(`${deriveCastEventContextHash(election)}\n`);
} catch (error) {
  process.stderr.write(`cast context derivation failed: ${error.message}\n`);
  process.exitCode = 1;
}
