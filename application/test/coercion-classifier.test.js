'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateThreshold, trainThreshold, wilsonInterval } = require('../src/lib/coercionClassifier');

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
