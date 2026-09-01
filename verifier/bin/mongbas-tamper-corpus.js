#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('../src/verify');

const [input, outputDirectory] = process.argv.slice(2);
if (!input || !outputDirectory) {
  process.stderr.write('Usage: mongbas-tamper-corpus <valid-vector-v3-bundle.json> <output-directory>\n');
  process.exit(2);
}

try {
  const bundle = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  if (bundle.schema !== 'mongbas-election-bundle/v3' || bundle.ballots?.length < 2) {
    throw new Error('a vector-v3 bundle with at least two ballots is required');
  }
  const mutations = {
    'ballot-deleted': value => { value.ballots.pop(); },
    'ballot-replaced': value => { value.ballots[0] = structuredClone(value.ballots[1]); },
    'ballots-reordered': value => { value.ballots.reverse(); },
    'ciphertext-changed': value => { value.ballots[0].ciphertextVector[0].c1 = '2'; },
    'proof-deleted': value => { delete value.ballots[0].validityProof; },
    'proof-changed': value => { value.ballots[0].validityProof.sumProof.z = '0'; },
    'root-changed': value => { value.bulletinBoard.root = '00'.repeat(32); },
    'aggregate-changed': value => { value.aggregateCiphertextVector[0].c1 = '2'; },
    'partial-value-changed': value => { value.vectorPartialDecryptions[0].values[0] = '2'; },
    'partial-proof-changed': value => { value.vectorPartialDecryptions[0].proofs[0].z = '0'; },
    'tally-changed': value => { value.tally.results[value.configuration.candidates[0]] += 1; },
    'signature-deleted': value => { value.signatures.pop(); },
    'signature-changed': value => { value.signatures[0].signature = Buffer.alloc(64).toString('base64'); },
    'algorithm-downgraded': value => { value.algorithms.tally = 'none'; },
    'ballot-duplicated': value => { value.ballots.push(structuredClone(value.ballots[0])); },
  };
  fs.mkdirSync(path.resolve(outputDirectory), { recursive: true, mode: 0o700 });
  const manifest = [];
  for (const [name, mutate] of Object.entries(mutations)) {
    const changed = structuredClone(bundle);
    mutate(changed);
    const filename = `${name}.json`;
    fs.writeFileSync(path.join(path.resolve(outputDirectory), filename), canonicalize(changed), { mode: 0o600 });
    manifest.push({ name, filename, expectedExit: 1 });
  }
  fs.writeFileSync(path.join(path.resolve(outputDirectory), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ corpus: manifest.length, outputDirectory: path.resolve(outputDirectory) })}\n`);
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
}
