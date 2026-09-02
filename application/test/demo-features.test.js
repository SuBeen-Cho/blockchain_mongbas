'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { demoEndpointsEnabled } = require('../src/lib/demoFeatures');

test('demo transcript recording is explicit and impossible in production', () => {
  assert.equal(demoEndpointsEnabled({}), false);
  assert.equal(demoEndpointsEnabled({ ENABLE_DEMO_ENDPOINTS: 'false' }), false);
  assert.equal(demoEndpointsEnabled({ ENABLE_DEMO_ENDPOINTS: 'true', NODE_ENV: 'development' }), true);
  assert.equal(demoEndpointsEnabled({ ENABLE_DEMO_ENDPOINTS: 'true', NODE_ENV: 'production' }), false);
});
