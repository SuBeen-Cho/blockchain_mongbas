'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { demoEndpointsEnabled } = require('../src/lib/demoFeatures');

test('demo transcript recording is explicit and impossible in production', () => {
  assert.equal(demoEndpointsEnabled({}), false);
  assert.equal(demoEndpointsEnabled({ ENABLE_DEMO_ENDPOINTS: 'false' }), false);
  assert.equal(demoEndpointsEnabled({ ENABLE_DEMO_ENDPOINTS: 'true', NODE_ENV: 'development' }), true);
  assert.equal(demoEndpointsEnabled({ ENABLE_DEMO_ENDPOINTS: 'true', NODE_ENV: 'production' }), false);
});

test('dashboard-only demo feeds require administrator authentication', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/elections.js'), 'utf8');
  for (const route of ['live-count', 'live-votes', 'demo-events']) {
    assert.match(source, new RegExp(`router\\.get\\('/:id/${route.replace('-', '\\-')}', requireDemoEndpoint, requireAdmin,`), route);
  }
});

test('public QR demo launchers retain request rate limits', () => {
  for (const relative of ['../../scripts/demo-start.sh', '../../scripts/demo-up.sh', '../../scripts/demo-tunnel.sh']) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.doesNotMatch(source, /DISABLE_RATE_LIMITS=true/, relative);
  }
});
