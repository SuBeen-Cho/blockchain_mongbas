'use strict';

const DEFAULT_DELAYS_MS = Object.freeze([100, 250, 500, 1000, 2000, 4000]);
const MISSING_PREPARED_BALLOT = '준비된 vector ballot을 찾을 수 없습니다';

function errorText(error) {
  const values = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0 && seen.size < 64) {
    const value = pending.shift();
    if (value === null || value === undefined || seen.has(value)) continue;
    if (typeof value === 'string') {
      values.push(value);
      continue;
    }
    if (typeof value !== 'object') continue;
    seen.add(value);
    if (typeof value.message === 'string') values.push(value.message);
    for (const key of ['details', 'cause', 'errors']) {
      const nested = value[key];
      if (Array.isArray(nested)) pending.push(...nested);
      else if (nested !== undefined) pending.push(nested);
    }
  }
  return values.join('\n');
}

function isPreparedVectorVisibilityLag(error) {
  return Number(error?.code) === 10 && errorText(error).includes(MISSING_PREPARED_BALLOT);
}

function preparedVectorVisibilityRetry({
  delaysMs = DEFAULT_DELAYS_MS,
  sleep = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
} = {}) {
  if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.length > 10 ||
      delaysMs.some(delay => !Number.isInteger(delay) || delay < 0 || delay > 10000)) {
    throw new Error('prepared-vector retry delays must contain 1-10 integer values in [0, 10000]');
  }
  if (typeof sleep !== 'function') throw new Error('prepared-vector retry sleep must be a function');
  return Object.freeze({
    maxRetries: delaysMs.length,
    delayMs: retryIndex => delaysMs[retryIndex],
    shouldRetry: isPreparedVectorVisibilityLag,
    sleep,
  });
}

module.exports = {
  DEFAULT_DELAYS_MS,
  isPreparedVectorVisibilityLag,
  preparedVectorVisibilityRetry,
};
