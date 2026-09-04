'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  evaluateThreshold,
  meanDifferenceInterval,
  trainThreshold,
  wilsonInterval,
  withinEquivalenceMargin,
} = require('../src/lib/coercionClassifier');

test('threshold classifier is trained only on training rows and evaluated out of sample', () => {
  const training = [
    { label: 'normal', elapsedMs: 1 }, { label: 'normal', elapsedMs: 2 },
    { label: 'panic', elapsedMs: 8 }, { label: 'panic', elapsedMs: 9 },
  ];
  const model = trainThreshold(training, 'elapsedMs');
  const result = evaluateThreshold(model, [
    { label: 'normal', elapsedMs: 3 }, { label: 'panic', elapsedMs: 7 },
  ]);
  assert.equal(result.accuracy, 1);
  assert.equal(result.total, 2);
});

test('Wilson interval validates counts and contains the observed proportion', () => {
  const interval = wilsonInterval(50, 100);
  assert.ok(interval.lower < 0.5 && interval.upper > 0.5);
  assert.throws(() => wilsonInterval(2, 1), /invalid binomial/);
});

test('mean-difference interval is symmetric and equivalence requires the whole interval inside the margin', () => {
  const interval = meanDifferenceInterval([10, 11, 9, 10], [11, 12, 10, 11]);
  assert.equal(interval.difference, 1);
  assert.ok(interval.lower < interval.difference);
  assert.ok(interval.upper > interval.difference);
  assert.equal(withinEquivalenceMargin(interval, 4), true);
  assert.equal(withinEquivalenceMargin(interval, 1), false);
  assert.throws(() => meanDifferenceInterval([1], [1, 2]), /at least two/);
  assert.throws(() => withinEquivalenceMargin(interval, 0), /positive/);
});

test('classifier advantage gate uses its confidence upper bound, not point accuracy alone', () => {
  const small = evaluateThreshold({ field: 'elapsedMs', threshold: 5, direction: 'above-is-panic' }, [
    { label: 'normal', elapsedMs: 1 },
    { label: 'panic', elapsedMs: 2 },
  ]);
  assert.equal(small.accuracy, 0.5);
  assert.ok(small.confidence95.upper > 0.6);
});

test('Linux coercion runner disables inherited admission enforcement for its non-demo backend', () => {
  const runner = fs.readFileSync(path.join(__dirname, '../../deploy/linux/coercion-evaluation.sh'), 'utf8');
  assert.match(runner, /REQUIRE_DEMO_ADMISSION=false/);
});

test('coercion transcript requests have a bounded timeout', () => {
  const evaluator = fs.readFileSync(path.join(__dirname, '../scripts/coercion-transcript-evaluation.js'), 'utf8');
  assert.match(evaluator, /COERCION_REQUEST_TIMEOUT_MS/);
  assert.match(evaluator, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
});
