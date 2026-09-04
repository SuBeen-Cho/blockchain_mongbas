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

test('Linux runtime containment is persistent and applies before Tailscale forwarding', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../deploy/linux/contain-fabric-ingress.sh'), 'utf8');
  const unit = fs.readFileSync(path.join(__dirname,
    '../../deploy/linux/systemd/mongbas-fabric-ingress-containment.service'), 'utf8');
  assert.match(script, /-I FORWARD 1/);
  assert.match(script, /--ctstate NEW/);
  assert.match(script, /mongbas-deny-external-container-ingress/);
  assert.match(script, /apply_family iptables/);
  assert.match(script, /apply_family ip6tables/);
  assert.match(unit, /After=docker\.service tailscaled\.service/);
  assert.match(unit, /ExecStart=\/usr\/local\/sbin\/mongbas-contain-fabric-ingress/);
});

test('chaincode upgrade never re-invokes InitLedger on an existing channel definition', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /if \[ "\$\{CURRENT_SEQ\}" -eq 0 \]; then[\s\S]*?--ctor '\{"function":"InitLedger","Args":\[\]\}'/);
  assert.match(script, /else[\s\S]*?기존 sequence \$\{CURRENT_SEQ\} upgrade: InitLedger를 호출하지 않습니다/);
  assert.equal((script.match(/--ctor '\{"function":"InitLedger","Args":\[\]\}'/g) || []).length, 1);
});

test('chaincode upgrade preserves the running image and rejects a definition race before commit', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /CURRENT_SEQ_BEFORE_BUILD=.*querycommitted/);
  assert.match(script, /rollback-seq-\$\{CURRENT_SEQ_BEFORE_BUILD\}/);
  assert.match(script, /docker image tag "\$\{CURRENT_IMAGE_ID\}" "\$\{ROLLBACK_IMAGE_TAG\}"/);
  assert.match(script, /CURRENT_SEQ.*CURRENT_SEQ_BEFORE_BUILD[\s\S]*definition changed during chaincode build\/install/);
  assert.ok(script.indexOf('CURRENT_SEQ_BEFORE_BUILD=') < script.indexOf('docker compose -f'),
    'committed definition and rollback image must be captured before rebuilding the mutable tag');
});

test('chaincode deployment requires all three named MSP approvals before commit', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /READINESS_JSON=\$\(peer lifecycle chaincode checkcommitreadiness/);
  assert.match(script, /ElectionCommissionMSP.*PartyObserverMSP.*CivilSocietyMSP/);
  assert.match(script, /all required MSP approvals are not ready/);
  assert.ok(script.indexOf('all required MSP approvals are not ready') < script.indexOf('peer lifecycle chaincode commit'),
    'exact three-MSP readiness gate must execute before lifecycle commit');
});

test('chaincode deployment verifies the committed sequence and version after commit', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /COMMITTED_JSON=\$\(peer lifecycle chaincode querycommitted/);
  assert.match(script, /committed chaincode definition does not match requested sequence\/version/);
  assert.ok(script.indexOf('peer lifecycle chaincode commit') < script.indexOf('COMMITTED_JSON='));
  assert.ok(script.indexOf('COMMITTED_JSON=') < script.indexOf('if [ "${CURRENT_SEQ}" -eq 0 ]'));
});
