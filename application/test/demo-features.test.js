'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('demo launchers never kill unrelated processes and public tunnels require opt-in', () => {
  for (const relative of ['../../scripts/demo-start.sh', '../../scripts/demo-up.sh', '../../scripts/demo-stop.sh', '../../scripts/demo-reset.sh']) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.doesNotMatch(source, /pkill|killall/);
  }
  for (const relative of ['../../scripts/demo-up.sh', '../../scripts/demo-tunnel.sh']) {
    const source = fs.readFileSync(path.join(__dirname, relative), 'utf8');
    assert.match(source, /MONGBAS_ALLOW_PUBLIC_TUNNEL/);
  }
  const processLibrary = fs.readFileSync(path.join(__dirname, '../../scripts/demo-process-lib.sh'), 'utf8');
  assert.match(processLibrary, /expected_cwd/);
  assert.match(processLibrary, /kill -0/);
  assert.doesNotMatch(processLibrary, /pkill|killall/);
});

test('destructive demo reset requires an exact confirmation before any operation', () => {
  const reset = path.join(__dirname, '../../scripts/demo-reset.sh');
  const result = spawnSync(reset, [], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /REFUSED/);
  assert.match(result.stderr, /--confirm-destroy-demo-ledger/);
  const source = fs.readFileSync(reset, 'utf8');
  assert.ok(source.indexOf('--confirm-destroy-demo-ledger') < source.indexOf('demo_runtime_init'));
});

test('Fabric volume and ledger deletion requires an exact confirmation before setup', () => {
  const network = path.join(__dirname, '../../network/scripts/network.sh');
  for (const command of ['down', 'clean']) {
    const result = spawnSync(network, [command], { encoding: 'utf8' });
    assert.equal(result.status, 2, command);
    assert.equal(result.stdout, '', command);
    assert.match(result.stderr, /REFUSED/, command);
    assert.match(result.stderr, /--confirm-destroy-ledger/, command);
  }
  const source = fs.readFileSync(network, 'utf8');
  assert.ok(source.indexOf('--confirm-destroy-ledger') < source.indexOf('docker-compose.yaml'));
  assert.doesNotMatch(source, /\[ -d crypto-config \].*rm -rf crypto-config/);
  assert.match(source, /REFUSED: existing crypto-config/);
});

test('Fabric BatchTimeout mutation requires an exact value and confirmation before setup', () => {
  const update = path.join(__dirname, '../../scripts/update-batchtimeout.sh');
  for (const args of [[], ['2s'], ['invalid', '--confirm-channel-config-update']]) {
    const result = spawnSync(update, args, { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
  const source = fs.readFileSync(update, 'utf8');
  assert.match(source, /--confirm-channel-config-update/);
  assert.ok(source.indexOf('--confirm-channel-config-update') < source.indexOf('PROJECT_DIR='));
  assert.doesNotMatch(source, /trap\s+"rm -rf/);
});
