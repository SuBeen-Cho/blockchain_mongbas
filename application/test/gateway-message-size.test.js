'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { grpcMaxMessageBytes, grpcClientOptions, resolveNetworkDir } = require('../src/gateway');

test('Fabric network artifacts can be supplied from a protected absolute runtime path', () => {
  assert.equal(resolveNetworkDir({ FABRIC_NETWORK_DIR: '/srv/mongbas/network' }),
    path.normalize('/srv/mongbas/network'));
  assert.throws(() => resolveNetworkDir({ FABRIC_NETWORK_DIR: '../network' }), /absolute path/);
});

test('Fabric gRPC message limit supports bounded large public evidence', () => {
  assert.equal(grpcMaxMessageBytes({}), 64 * 1024 * 1024);
  const options = grpcClientOptions('peer.example', { FABRIC_GRPC_MAX_MESSAGE_BYTES: String(8 * 1024 * 1024) });
  assert.equal(options['grpc.ssl_target_name_override'], 'peer.example');
  assert.equal(options['grpc.max_receive_message_length'], 8 * 1024 * 1024);
  assert.equal(options['grpc.max_send_message_length'], 8 * 1024 * 1024);
});

test('Fabric gRPC message limit rejects unsafe or malformed bounds', () => {
  for (const value of ['0', '4194303', '268435457', '1.5', 'not-a-number']) {
    assert.throws(() => grpcMaxMessageBytes({ FABRIC_GRPC_MAX_MESSAGE_BYTES: value }));
  }
});
