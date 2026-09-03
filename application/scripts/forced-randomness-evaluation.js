#!/usr/bin/env node
'use strict';

const { generateVectorBallot, verifyVectorAuditWitness } = require('../src/lib/vectorElgamal');

function main() {
  const pubKey = {
    p: 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f',
    q: '7fffffffffffffffffffffffffffffffffffffffffffffffffffffff7ffffe17',
    g: '2',
    y: '4',
  };
  const candidateCount = 3;
  const selectedIndex = 1;
  const ballot = generateVectorBallot(pubKey, selectedIndex, candidateCount);
  const witness = ballot._auditWitness;
  const acceptedGuesses = [];
  for (let guess = 0; guess < candidateCount; guess += 1) {
    if (verifyVectorAuditWitness(pubKey, ballot.encryptedCandidateVector,
      { selectedIndex: guess, randomness: witness.randomness })) acceptedGuesses.push(guess);
  }
  const summary = {
    schema: 'mongbas-forced-randomness-evaluation/v1',
    adversaryModel: 'coercer-controls-or-obtains-all-elgamal-randomness-for-a-cast-ballot',
    candidateCount,
    acceptedSelectionGuesses: acceptedGuesses.length,
    uniquelyRecoveredSelection: acceptedGuesses.length === 1,
    castClientExportsRandomnessByDefault: false,
    verdict: acceptedGuesses.length === 1 ? 'failed-under-declared-model' : 'not-demonstrated',
    limitation: 'The normal cast UI does not export the audit witness. This counterexample applies only when a coercer controls ballot generation or obtains every encryption random scalar; it is not an ordinary public-transcript attack.',
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.verdict === 'failed-under-declared-model') process.exitCode = 1;
  else process.exitCode = 2;
}

try { main(); } catch (error) {
  process.stderr.write(`INVALID: ${error.message}\n`);
  process.exitCode = 2;
}
