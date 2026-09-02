#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  generateTransportKeyPair, createContribution, finalizeTrusteeShare, finalizeTranscript,
  createComplaint, createVectorPartialDecryption,
} = require('../src/dkg');

function usage() {
  process.stderr.write(`Usage:
  mongbas-trustee init --id ID --index 1..3 --private FILE --public FILE
  mongbas-trustee contribute --ceremony ID --id ID --private FILE --participants FILE --out FILE
  mongbas-trustee complain --ceremony ID --id ID --dealer ID --reason CODE --contribution-hash HEX --evidence-hash HEX --private FILE --participants FILE --out FILE
  mongbas-trustee finalize-share --ceremony ID --id ID --private FILE --participants FILE --contributions-dir DIR --private-out FILE --public-out FILE
  mongbas-trustee finalize-transcript --ceremony ID --participants FILE --contributions-dir DIR --public-shares-dir DIR --out FILE
  mongbas-trustee partial --election ID --private-share FILE --aggregate FILE --out FILE
`);
}

function args(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { parsed._.push(value); continue; }
    const key = value.slice(2);
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`missing value for --${key}`);
    if (Object.hasOwn(parsed, key)) throw new Error(`duplicate --${key}`);
    parsed[key] = argv[++index];
  }
  return parsed;
}

function requireArg(parsed, name) {
  if (!parsed[name]) throw new Error(`--${name} is required`);
  return parsed[name];
}

function readJson(file, { privateFile = false } = {}) {
  if (privateFile && process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) throw new Error(`private file must have mode 0600: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readSchemaDirectory(directory, schema) {
  const values = [];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.json')) continue;
    const value = readJson(path.join(directory, name));
    if (value.schema === schema) values.push(value);
  }
  return values;
}

function writeExclusive(file, value, mode) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function main() {
  const parsed = args(process.argv.slice(2));
  const command = parsed._[0];
  if (!command || parsed._.length !== 1) { usage(); process.exitCode = 2; return; }
  if (command === 'init') {
    const pair = generateTransportKeyPair(requireArg(parsed, 'id'), Number(requireArg(parsed, 'index')));
    writeExclusive(requireArg(parsed, 'private'), pair.privateRecord, 0o600);
    writeExclusive(requireArg(parsed, 'public'), pair.publicDescriptor, 0o644);
    process.stdout.write(`INITIALIZED: ${pair.publicDescriptor.id} index=${pair.publicDescriptor.index}\n`);
    return;
  }
  if (command === 'contribute') {
    const privateRecord = readJson(requireArg(parsed, 'private'), { privateFile: true });
    const contribution = createContribution({
      ceremonyID: requireArg(parsed, 'ceremony'), dealerID: requireArg(parsed, 'id'), privateRecord,
      participants: readJson(requireArg(parsed, 'participants')),
    });
    writeExclusive(requireArg(parsed, 'out'), contribution, 0o644);
    process.stdout.write(`CONTRIBUTED: ${contribution.dealerID}\n`);
    return;
  }
  if (command === 'complain') {
    const complaint = createComplaint({
      ceremonyID: requireArg(parsed, 'ceremony'), complainerID: requireArg(parsed, 'id'), dealerID: requireArg(parsed, 'dealer'),
      reason: requireArg(parsed, 'reason'), contributionHash: requireArg(parsed, 'contribution-hash'),
      evidenceHash: requireArg(parsed, 'evidence-hash'), privateRecord: readJson(requireArg(parsed, 'private'), { privateFile: true }),
      participants: readJson(requireArg(parsed, 'participants')),
    });
    writeExclusive(requireArg(parsed, 'out'), complaint, 0o644);
    process.stdout.write(`COMPLAINT: ${complaint.complaintID} dealer=${complaint.dealerID}\n`);
    return;
  }
  if (command === 'finalize-share') {
    const ceremonyID = requireArg(parsed, 'ceremony');
    const finalized = finalizeTrusteeShare({
      ceremonyID, trusteeID: requireArg(parsed, 'id'),
      privateRecord: readJson(requireArg(parsed, 'private'), { privateFile: true }),
      participants: readJson(requireArg(parsed, 'participants')),
      contributions: readSchemaDirectory(requireArg(parsed, 'contributions-dir'), 'mongbas-feldman-dkg-contribution/v1'),
    });
    writeExclusive(requireArg(parsed, 'private-out'), finalized.privateShare, 0o600);
    writeExclusive(requireArg(parsed, 'public-out'), finalized.publicShare, 0o644);
    process.stdout.write(`FINALIZED_SHARE: ${finalized.publicShare.trusteeID} index=${finalized.publicShare.trusteeIndex}\n`);
    return;
  }
  if (command === 'finalize-transcript') {
    const transcript = finalizeTranscript({
      ceremonyID: requireArg(parsed, 'ceremony'),
      participants: readJson(requireArg(parsed, 'participants')),
      contributions: readSchemaDirectory(requireArg(parsed, 'contributions-dir'), 'mongbas-feldman-dkg-contribution/v1'),
      publicShares: readSchemaDirectory(requireArg(parsed, 'public-shares-dir'), 'mongbas-dkg-public-share/v1'),
	  complaints: parsed['complaints-dir'] ? readSchemaDirectory(parsed['complaints-dir'], 'mongbas-dkg-complaint/v1') : [],
    });
    writeExclusive(requireArg(parsed, 'out'), transcript, 0o644);
    process.stdout.write(`FINALIZED_TRANSCRIPT: ${transcript.transcriptHash}\n`);
    return;
  }
  if (command === 'partial') {
    const aggregate = readJson(requireArg(parsed, 'aggregate'));
    const encryptedAggregateVector = Array.isArray(aggregate) ? aggregate : aggregate.encAggVector;
    const partial = createVectorPartialDecryption({
      privateShare: readJson(requireArg(parsed, 'private-share'), { privateFile: true }),
      electionID: requireArg(parsed, 'election'), encryptedAggregateVector,
    });
    writeExclusive(requireArg(parsed, 'out'), partial, 0o644);
    process.stdout.write(`CREATED_PARTIAL: ${partial.mspID} index=${partial.index} proofs=${partial.proofs.length}\n`);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

try { main(); } catch (error) {
  process.stderr.write(`mongbas-trustee: ${error.message}\n`);
  process.exitCode = 1;
}
