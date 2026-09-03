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
