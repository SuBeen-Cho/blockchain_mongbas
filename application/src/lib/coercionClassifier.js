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

module.exports = { evaluateThreshold, trainThreshold, wilsonInterval };
