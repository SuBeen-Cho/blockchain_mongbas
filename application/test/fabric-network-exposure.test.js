'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Fabric CouchDB development ports are loopback-only because they contain PDC plaintext', () => {
  const compose = fs.readFileSync(path.join(__dirname, '../../network/docker-compose.yaml'), 'utf8');
  for (const port of ['5984', '5985', '6984', '7984']) {
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${port}:5984`));
    assert.doesNotMatch(compose, new RegExp(`(?:^|[\\s"'])${port}:5984(?:[\\s"']|$)`, 'm'));
  }
});

test('single-host Fabric profile does not publish CA, node, admin or operations ports off-host', () => {
  const compose = fs.readFileSync(path.join(__dirname, '../../network/docker-compose.yaml'), 'utf8');
  const published = [...compose.matchAll(/^\s+-\s+"([^"\n]+:[0-9]+)"\s*(?:#.*)?$/gm)].map(match => match[1]);
  assert.ok(published.length >= 20, 'expected the complete single-host published-port inventory');
  for (const mapping of published) assert.match(mapping, /^127\.0\.0\.1:[0-9]+:[0-9]+$/);
});
