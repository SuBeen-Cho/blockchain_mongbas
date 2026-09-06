'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('Fabric compose has no public fixed service credentials and requires a protected secret file', () => {
  const compose = fs.readFileSync(path.join(__dirname, '../../network/docker-compose.yaml'), 'utf8');
  const network = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  const prepare = fs.readFileSync(path.join(__dirname, '../../network/scripts/prepare-network-secrets.sh'), 'utf8');
  assert.doesNotMatch(compose, /adminpw|voter1pw|start -b admin:/);
  for (const name of ['MONGBAS_COUCHDB_USER', 'MONGBAS_COUCHDB_PASSWORD',
    'MONGBAS_CA_EC_BOOTSTRAP_USER', 'MONGBAS_CA_EC_BOOTSTRAP_PASSWORD',
    'MONGBAS_CA_PARTY_BOOTSTRAP_USER', 'MONGBAS_CA_PARTY_BOOTSTRAP_PASSWORD',
    'MONGBAS_CA_CIVIL_BOOTSTRAP_USER', 'MONGBAS_CA_CIVIL_BOOTSTRAP_PASSWORD']) {
    assert.match(compose, new RegExp(`\\$\\{${name}:\\?`));
  }
  assert.match(network, /prepare-network-secrets\.sh/);
  assert.match(prepare, /umask 077/);
  assert.match(prepare, /openssl rand -hex 32/);
  assert.match(prepare, /chmod 0600/);
  assert.doesNotMatch(prepare, /set\s+-x|echo\s+.*(?:password|_password)/i);
});

test('network secret preparation is private, complete and non-overwriting', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-network-secrets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(__dirname, '../../network/scripts/prepare-network-secrets.sh');
  const first = spawnSync(script, [directory], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  const secretFile = path.join(directory, '.env');
  assert.equal(fs.lstatSync(secretFile).isFile(), true);
  assert.equal(fs.lstatSync(secretFile).isSymbolicLink(), false);
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  const before = fs.readFileSync(secretFile);
  const names = before.toString('utf8').trim().split('\n').map(line => line.split('=', 1)[0]);
  assert.deepEqual(names, ['MONGBAS_COUCHDB_USER', 'MONGBAS_COUCHDB_PASSWORD',
    'MONGBAS_CA_EC_BOOTSTRAP_USER', 'MONGBAS_CA_EC_BOOTSTRAP_PASSWORD',
    'MONGBAS_CA_PARTY_BOOTSTRAP_USER', 'MONGBAS_CA_PARTY_BOOTSTRAP_PASSWORD',
    'MONGBAS_CA_CIVIL_BOOTSTRAP_USER', 'MONGBAS_CA_CIVIL_BOOTSTRAP_PASSWORD']);
  const digest = crypto.createHash('sha256').update(before).digest('hex');
  const second = spawnSync(script, [directory], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(secretFile)).digest('hex'), digest);
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

test('CCAAS upgrade uses a sequence-bound candidate without replacing live code before commit', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /CHAINCODE_LABEL=.*seq\$\{NEXT_SEQ_BEFORE_BUILD\}/);
  assert.match(script, /CHAINCODE_CONTAINER_NAME=.*seq-\$\{NEXT_SEQ_BEFORE_BUILD\}/);
  assert.match(script, /"address": "\$\{CHAINCODE_CONTAINER_NAME\}:7052"/);
  assert.match(script, /if \[ "\$\{CURRENT_SEQ_BEFORE_BUILD\}" -eq 0 \]; then[\s\S]*docker rm -f voting-chaincode/);
  assert.match(script, /else[\s\S]*candidate container already exists; refusing to replace it/);
  assert.ok(script.indexOf('docker run -d') < script.indexOf('peer lifecycle chaincode commit'));
  assert.ok(script.indexOf('peer lifecycle chaincode commit') < script.indexOf('docker image tag "${DEPLOY_IMAGE_TAG}" voting-chaincode:1.0'));
});

test('CCAAS packaging uses a private temporary directory instead of deleting a fixed path', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.doesNotMatch(script, /CCAAS_PKG="\/tmp\/voting_ccaas_pkg"/);
  assert.match(script, /CCAAS_PKG=\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/mongbas-voting-ccaas\.XXXXXX"\)/);
  assert.match(script, /chmod 0700 "\$\{CCAAS_PKG\}"/);
  assert.match(script, /rm -rf -- "\$\{CCAAS_PKG\}"/);
});

test('CCAAS package carries CouchDB index metadata and verifies its archive path', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /cp -R "\$\{CHAINCODE_PATH\}\/META-INF" "\$\{CCAAS_PKG\}\/META-INF"/);
  assert.match(script, /tar czf code\.tar\.gz connection\.json META-INF/);
  assert.match(script, /tar tzf code\.tar\.gz[^\n]*META-INF\/statedb\/couchdb\/indexes\/indexElection\.json/);
});

test('CCAAS candidate is running before approval and callable before current tag advances', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /candidate failed to remain running before lifecycle approval/);
  assert.match(script, /GetSecurityProperties/);
  assert.match(script, /committed candidate chaincode is not callable/);
  assert.ok(script.indexOf('candidate failed to remain running') < script.indexOf('peer lifecycle chaincode approveformyorg'));
  assert.ok(script.indexOf('committed candidate chaincode is not callable') <
    script.indexOf('docker image tag "${DEPLOY_IMAGE_TAG}" voting-chaincode:1.0'));
});

test('CCAAS binary upgrade advances both lifecycle sequence and version metadata', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../network/scripts/network.sh'), 'utf8');
  assert.match(script, /CHAINCODE_VERSION="\$\{CHAINCODE_VERSION\}\.seq\$\{NEXT_SEQ_BEFORE_BUILD\}"/);
  assert.ok(script.indexOf('CHAINCODE_VERSION="${CHAINCODE_VERSION}.seq${NEXT_SEQ_BEFORE_BUILD}"') <
    script.indexOf('CHAINCODE_LABEL="${CHAINCODE_NAME}_${CHAINCODE_VERSION}_seq${NEXT_SEQ_BEFORE_BUILD}"'));
});
