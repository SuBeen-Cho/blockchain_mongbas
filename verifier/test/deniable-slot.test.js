'use strict';

// The fixture is a signed bundle exported from a live Fabric election with
// panicPolicy deniable-slot-v1: voter 1 normal A -> panic B, voter 2 panic only,
// voter 3 normal C, voter 4 normal A -> normal B. Expected tally A1 B1 C1 of 4.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { verifyBundle } = require('../src/verify');

const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/deniable-bundle-v6.json'), 'utf8'));
const unsignedCopy = () => { const copy = structuredClone(bundle); copy.signatures = []; return copy; };
const errorsOf = (candidate) => verifyBundle(candidate).errors.filter((error) => !error.startsWith('signatures'));

test('live deniable-slot bundle verifies with panic casts included', () => {
  const result = verifyBundle(bundle);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(bundle.schema, 'mongbas-election-bundle/v6');
  assert.deepEqual(bundle.tally.results, { CANDIDATE_A: 1, CANDIDATE_B: 1, CANDIDATE_C: 1 });
  assert.equal(bundle.tally.totalVotes, 4);
});

test('counted slot cannot be swapped for the visible (panic) ballot', () => {
  const copy = unsignedCopy();
  const ballot = copy.ballots.find((b) => b.countedSlotChain.length > 1);
  const last = ballot.countedSlotChain.at(-1);
  last.countedVector = last.encryptedCandidateVector;
  assert.ok(errorsOf(copy).length > 0);
});

test('slot history cannot be truncated or reordered', () => {
  const copy = unsignedCopy();
  copy.ballots.find((b) => b.countedSlotChain.length > 1).countedSlotChain.shift();
  assert.ok(errorsOf(copy).some((e) => /countedSlotChain/.test(e)));
});

test('disjunctive proof challenges are bound', () => {
  const copy = unsignedCopy();
  const proof = copy.ballots[0].countedSlotChain[0].countedSlotProof;
  proof.c = [proof.c[1], proof.c[0]];
  assert.ok(errorsOf(copy).some((e) => /counted slot proof failed/.test(e)));
});

test('v6 requires the declared panic policy and slot chains', () => {
  const noPolicy = unsignedCopy();
  delete noPolicy.configuration.panicPolicy;
  assert.ok(errorsOf(noPolicy).length > 0);
  const noChain = unsignedCopy();
  delete noChain.ballots[0].countedSlotChain;
  assert.ok(errorsOf(noChain).length > 0);
});

test('tally sum may not exceed the number of slots', () => {
  const copy = unsignedCopy();
  copy.tally.results.CANDIDATE_A = 5;
  assert.ok(errorsOf(copy).some((e) => /sum mismatch|partial|tally/.test(e)));
});
