'use strict';

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) {
    throw new Error('invalid binomial counts');
  }
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;
  return { lower: center - margin, upper: center + margin };
}

function classifyThreshold(value, threshold, direction) {
  return direction === 'above-is-panic' ? value > threshold : value <= threshold;
}

function trainThreshold(rows, field) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('at least two training rows are required');
  const sorted = [...new Set(rows.map(row => row[field]))].sort((a, b) => a - b);
  if (sorted.some(value => !Number.isFinite(value))) throw new Error(`non-finite ${field}`);
  const candidates = [sorted[0] - Number.EPSILON];
  for (let index = 0; index < sorted.length - 1; index += 1) candidates.push((sorted[index] + sorted[index + 1]) / 2);
  candidates.push(sorted.at(-1));
  let best = null;
  for (const threshold of candidates) {
    for (const direction of ['above-is-panic', 'below-is-panic']) {
      const correct = rows.filter(row => classifyThreshold(row[field], threshold, direction) === (row.label === 'panic')).length;
      const candidate = { field, threshold, direction, trainingCorrect: correct, trainingTotal: rows.length };
      if (!best || correct > best.trainingCorrect || (correct === best.trainingCorrect && threshold < best.threshold)) best = candidate;
    }
  }
  return best;
}

function evaluateThreshold(model, rows) {
  const correct = rows.filter(row => classifyThreshold(row[model.field], model.threshold, model.direction) === (row.label === 'panic')).length;
  return { correct, total: rows.length, accuracy: correct / rows.length, confidence95: wilsonInterval(correct, rows.length) };
}

function finiteSample(values, label) {
  if (!Array.isArray(values) || values.length < 2) throw new Error(`at least two ${label} samples are required`);
  if (values.some(value => !Number.isFinite(value))) throw new Error(`non-finite ${label} sample`);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return { count: values.length, mean, variance };
}

function meanDifferenceInterval(referenceValues, comparisonValues, critical = 1.959963984540054) {
  if (!Number.isFinite(critical) || critical <= 0) throw new Error('critical value must be positive');
  const reference = finiteSample(referenceValues, 'reference');
  const comparison = finiteSample(comparisonValues, 'comparison');
  const difference = comparison.mean - reference.mean;
  const standardError = Math.sqrt((reference.variance / reference.count) + (comparison.variance / comparison.count));
  const radius = critical * standardError;
  return {
    reference,
    comparison,
    difference,
    standardError,
    confidence: 0.95,
    method: 'large-sample-Welch-normal-approximation',
    lower: difference - radius,
    upper: difference + radius,
  };
}

function withinEquivalenceMargin(interval, margin) {
  if (!Number.isFinite(margin) || margin <= 0) throw new Error('equivalence margin must be positive');
  if (!interval || !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)) {
    throw new Error('finite confidence interval is required');
  }
  return interval.lower > -margin && interval.upper < margin;
}

module.exports = {
  evaluateThreshold,
  meanDifferenceInterval,
  trainThreshold,
  wilsonInterval,
  withinEquivalenceMargin,
};
