#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function parseSnapshot(text) {
  const result = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [name, kind, kibText] = line.split('\t');
    const kib = Number(kibText);
    if (!name || !kind || !Number.isInteger(kib) || kib < 0 || result.has(name)) {
      throw new Error(`invalid storage snapshot row: ${line}`);
    }
    result.set(name, { kind, kib });
  }
  if (result.size === 0) throw new Error('storage snapshot is empty');
  return result;
}

function summarize(beforeText, afterText, ballots) {
  if (!Number.isInteger(ballots) || ballots < 1) throw new Error('ballots must be a positive integer');
  const before = parseSnapshot(beforeText);
  const after = parseSnapshot(afterText);
  const rows = [];
  for (const [name, first] of before) {
    const last = after.get(name);
    if (!last || last.kind !== first.kind) throw new Error(`snapshot target changed: ${name}`);
    rows.push({ name, kind: first.kind, beforeKiB: first.kib, afterKiB: last.kib, deltaKiB: last.kib - first.kib });
  }
  if (after.size !== before.size) throw new Error('snapshot target count changed');
  const totalDeltaKiB = rows.reduce((sum, row) => sum + row.deltaKiB, 0);
  if (totalDeltaKiB <= 0) throw new Error(`non-positive total storage delta: ${totalDeltaKiB}`);
  const byKind = Object.fromEntries([...new Set(rows.map(row => row.kind))].map(kind => [kind, {
    replicas: rows.filter(row => row.kind === kind).length,
    totalDeltaKiB: rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.deltaKiB, 0),
  }]));
  return {
    schema: 'mongbas-state-growth-summary/v2', ballots, targets: rows, byKind,
    totalBeforeKiB: rows.reduce((sum, row) => sum + row.beforeKiB, 0),
    totalAfterKiB: rows.reduce((sum, row) => sum + row.afterKiB, 0),
    totalDeltaKiB,
    replicatedTopologyBytesPerBallot: +(totalDeltaKiB * 1024 / ballots).toFixed(3),
  };
}

if (require.main === module) {
  const [beforePath, afterPath, ballotsText, outputPath] = process.argv.slice(2);
  if (!beforePath || !afterPath || !outputPath) throw new Error('usage: summarize-state-growth.js BEFORE AFTER BALLOTS OUTPUT');
  const value = summarize(fs.readFileSync(beforePath, 'utf8'), fs.readFileSync(afterPath, 'utf8'), Number(ballotsText));
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { parseSnapshot, summarize };
