#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('../src/verify');

const [input, outputDirectory] = process.argv.slice(2);
if (!input || !outputDirectory) {
  process.stderr.write('Usage: mongbas-tamper-corpus <valid-vector-v4-or-v5-bundle.json> <output-directory>\n');
  process.exit(2);
}

try {
  const bundle = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  if (!['mongbas-election-bundle/v4', 'mongbas-election-bundle/v5'].includes(bundle.schema) || bundle.ballots?.length < 2) {
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
    'cast-receipt-deleted': value => { value.vectorBallotReceipts = value.vectorBallotReceipts.filter(receipt => receipt.ballotID !== value.ballots[0].preparedBallotID); },
    'cast-artifact-changed': value => { value.vectorBallotReceipts.find(receipt => receipt.status === 'cast').artifactHash = '00'.repeat(32); },
    'receipt-duplicated': value => { value.vectorBallotReceipts.push(structuredClone(value.vectorBallotReceipts[0])); },
    'audit-disclosure-deleted': value => { value.vectorAuditDisclosures = []; },
    'audit-nonce-changed': value => { value.vectorAuditDisclosures[0].clientNonce = 'cd'.repeat(32); },
    'audit-randomness-changed': value => { value.vectorAuditDisclosures[0].randomness[0] = '1'; },
    'audited-ciphertext-changed': value => { value.vectorAuditDisclosures[0].encryptedCandidateVector[0].c2 = '2'; },
  };
	if (bundle.schema === 'mongbas-election-bundle/v5') {
	  Object.assign(mutations, {
		'dkg-approval-deleted': value => { value.keyCeremony.approvals.pop(); },
		'dkg-transcript-hash-changed': value => { value.keyCeremony.transcriptHash = '00'.repeat(32); },
		'dkg-commitment-changed': value => { value.keyCeremony.transcript.contributions[0].commitments.linear = '2'; },
		'dkg-public-share-changed': value => { value.keyCeremony.transcript.publicShares[0].publicKeyY = value.keyCeremony.transcript.publicShares[1].publicKeyY; },
		'dkg-election-key-changed': value => { value.keyCeremony.transcript.electionPublicKeyY = value.keyCeremony.transcript.publicShares[0].publicKeyY; },
		'dkg-bundle-share-changed': value => { value.trusteePublicShares[0].publicKeyY = value.trusteePublicShares[1].publicKeyY; },
	  });
	}
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
