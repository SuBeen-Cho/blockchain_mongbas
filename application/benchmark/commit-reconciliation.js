'use strict';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function classifyNullifierRecord(record, expected) {
  if (!record || typeof record !== 'object') return 'absent';
  if (record.electionID !== expected.electionID ||
      record.nullifierHash !== expected.nullifierHash ||
      record.preparedBallotID !== expected.ballotID) return 'mismatch';
  return 'match';
}

async function reconcileAmbiguousCast(expected, options) {
  const lookup = options.lookup;
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs ?? 120000;
  const intervalMs = options.intervalMs ?? 2000;
  const started = now();
  let attempts = 0;
  let lastStatus = 0;

  do {
    attempts += 1;
    const response = await lookup(expected.nullifierHash);
    lastStatus = response?.status || 0;
    if (response?.status >= 200 && response.status < 300) {
      const classification = classifyNullifierRecord(response.body, expected);
      if (classification === 'match') {
        return { outcome: 'late-committed', committed: true, attempts, elapsedMs: now() - started };
      }
      if (classification === 'mismatch') {
        return { outcome: 'invalid-mismatched', committed: false, attempts, elapsedMs: now() - started };
      }
    }
    if (now() - started >= timeoutMs) break;
    await sleep(intervalMs);
  } while (true);

  return { outcome: 'unresolved', committed: false, attempts, elapsedMs: now() - started, lastStatus };
}

module.exports = { classifyNullifierRecord, reconcileAmbiguousCast };
