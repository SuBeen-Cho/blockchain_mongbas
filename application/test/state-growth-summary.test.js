'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseSnapshot, summarize } = require('../benchmark/summarize-state-growth');

test('state growth summary computes per-target and aggregate deltas', () => {
  const value = summarize('peer\tledger\t100\ndb\tcouchdb\t200\n', 'peer\tledger\t140\ndb\tcouchdb\t260\n', 10);
  assert.equal(value.totalDeltaKiB, 100);
  assert.equal(value.replicatedTopologyBytesPerBallot, 10240);
  assert.deepEqual(value.byKind, { ledger: { replicas: 1, totalDeltaKiB: 40 }, couchdb: { replicas: 1, totalDeltaKiB: 60 } });
  assert.deepEqual(value.targets.map(row => row.deltaKiB), [40, 60]);
});

test('state growth summary fails closed on malformed, changed or non-growing snapshots', () => {
  assert.throws(() => parseSnapshot('peer\tledger\tnan\n'));
  assert.throws(() => summarize('peer\tledger\t100\n', 'other\tledger\t120\n', 1));
  assert.throws(() => summarize('peer\tledger\t100\n', 'peer\tledger\t100\n', 1));
});

test('100k state-growth wrapper monitors disk, memory, OOM and Fabric health without reset', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../deploy/linux/state-growth-evaluation.sh'), 'utf8');
  const rateSource = fs.readFileSync(path.join(__dirname, '../../deploy/linux/rate-evaluation.sh'), 'utf8');
  assert.match(source, /MONGBAS_STATE_GROWTH_MIN_FREE_BYTES/);
  assert.match(source, /MONGBAS_STATE_GROWTH_MIN_MEM_AVAILABLE_BYTES/);
  assert.match(source, /oom_kill/);
  assert.match(source, /health_seen/);
  assert.match(source, /container-not-running/);
  assert.match(source, /abort-reason\.txt/);
  assert.doesNotMatch(source, /docker compose down|docker volume rm|network\.sh (?:down|clean)/);
  assert.match(rateSource, /REQUIRE_DEMO_ADMISSION=false/);
});
