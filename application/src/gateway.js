/**
 * gateway.js — Hyperledger Fabric Gateway 연결 모듈
 *
 * Fabric Gateway SDK를 사용하여 피어에 gRPC로 연결하고
 * 체인코드 트랜잭션을 제출할 수 있는 contract 객체를 반환합니다.
 *
 * 연결 대상: peer0.ec.voting.example.com:7051 (선거관리위원회)
 * MSP: ElectionCommissionMSP
 *
 * ※ 실제 유권자 투표 시에는 각 유권자의 인증서로 별도 연결을 생성해야 합니다.
 *    이 모듈은 관리자 작업(선거 생성/종료, 결과 조회)에 사용합니다.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const grpc    = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

// ── 경로 설정 ──────────────────────────────────────────────────
const NETWORK_DIR  = path.resolve(__dirname, '../../network');
const CRYPTO_DIR   = path.join(NETWORK_DIR, 'crypto-config/peerOrganizations/ec.voting.example.com');

// peer0 TLS CA 인증서 (gRPC TLS 연결용)
const TLS_CA_CERT  = path.join(CRYPTO_DIR, 'peers/peer0.ec.voting.example.com/tls/ca.crt');

// 관리자 ID 인증서 & 개인키
// ※ 실제 배포 시 User1 → Admin으로 교체하거나 별도 등록된 사용자 사용
const ADMIN_CERT_DIR = path.join(CRYPTO_DIR, 'users/User1@ec.voting.example.com/msp');
const ADMIN_SIGNCERT = path.join(ADMIN_CERT_DIR, 'signcerts/User1@ec.voting.example.com-cert.pem');
const ADMIN_KEYSTORE = path.join(ADMIN_CERT_DIR, 'keystore');

const PEER_ENDPOINT   = 'localhost:7051';
const PEER_HOST_ALIAS = 'peer0.ec.voting.example.com';  // TLS SNI
const CHANNEL_NAME    = 'voting-channel';
const CHAINCODE_NAME  = 'voting';

const ORG_PROFILES = {
  ElectionCommissionMSP: {
    domain: 'ec.voting.example.com',
    peer: 'peer0.ec.voting.example.com',
    endpoint: 'localhost:7051',
    user: 'User1@ec.voting.example.com',
  },
  PartyObserverMSP: {
    domain: 'party.voting.example.com',
    peer: 'peer0.party.voting.example.com',
    endpoint: 'localhost:8051',
    user: 'User1@party.voting.example.com',
  },
  CivilSocietyMSP: {
    domain: 'civil.voting.example.com',
    peer: 'peer0.civil.voting.example.com',
    endpoint: 'localhost:9051',
    user: 'User1@civil.voting.example.com',
  },
};

const SHARE_INDEX_MSP = {
  '1': 'ElectionCommissionMSP',
  '2': 'PartyObserverMSP',
  '3': 'CivilSocietyMSP',
};

/**
 * keystore 폴더에서 개인키 파일(priv_sk)을 읽어 반환합니다.
 * cryptogen은 랜덤 파일명을 사용하므로 폴더 내 첫 번째 파일을 사용합니다.
 */
function readPrivateKey(keystoreDir) {
  const files = fs.readdirSync(keystoreDir);
  if (files.length === 0) throw new Error(`keystore 폴더가 비어있습니다: ${keystoreDir}`);
  const keyPath = path.join(keystoreDir, files[0]);
  return fs.readFileSync(keyPath);
}

/**
 * gRPC 클라이언트를 생성합니다 (TLS 포함).
 */
function newGrpcClient(tlsCaCert = TLS_CA_CERT, endpoint = PEER_ENDPOINT, hostAlias = PEER_HOST_ALIAS) {
  const tlsCert = fs.readFileSync(tlsCaCert);
  const creds   = grpc.credentials.createSsl(tlsCert);
  return new grpc.Client(endpoint, creds, {
    'grpc.ssl_target_name_override': hostAlias,
  });
}

/**
 * Fabric Gateway 연결을 생성하고 { gateway, contract } 를 반환합니다.
 *
 * @returns {{ gateway: Gateway, contract: Contract }}
 *
 * 사용 후 반드시 gateway.close() 를 호출하여 gRPC 연결을 해제하세요.
 *
 * @example
 *   const { gateway, contract } = await connectGateway();
 *   try {
 *     const result = await contract.evaluateTransaction('GetElection', 'ELECTION_2026_PRESIDENT');
 *     console.log(JSON.parse(result.toString()));
 *   } finally {
 *     gateway.close();
 *   }
 */
async function connectGateway() {
  const client     = newGrpcClient();
  const certPem    = fs.readFileSync(ADMIN_SIGNCERT);
  const keyPem     = readPrivateKey(ADMIN_KEYSTORE);
  const privateKey = crypto.createPrivateKey(keyPem);

  const gateway = connect({
    client,
    identity: {
      mspId:       'ElectionCommissionMSP',
      credentials: certPem,
    },
    signer: signers.newPrivateKeySigner(privateKey),
    // 트랜잭션 제출 타임아웃 (기본값 대비 여유 있게 설정)
    evaluateOptions:        () => ({ deadline: Date.now() + 5_000 }),
    endorseOptions:         () => ({ deadline: Date.now() + 15_000 }),
    submitOptions:          () => ({ deadline: Date.now() + 5_000 }),
    commitStatusOptions:    () => ({ deadline: Date.now() + 60_000 }),
  });

  const network  = gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);

  return { gateway, contract };
}

/**
 * 유권자용 Gateway 연결을 생성합니다.
 *
 * 실제 투표 시 유권자 자신의 인증서로 서명해야 익명성이 보장됩니다.
 * voterCertPem, voterKeyPem은 클라이언트에서 전달받거나
 * Fabric CA에서 등록 발급한 인증서를 사용합니다.
 *
 * @param {string} mspId         - 유권자 소속 MSP ID
 * @param {Buffer} voterCertPem  - 유권자 인증서 (PEM)
 * @param {Buffer} voterKeyPem   - 유권자 개인키 (PEM)
 * @returns {{ gateway: Gateway, contract: Contract }}
 */
async function connectGatewayAsVoter(mspId, voterCertPem, voterKeyPem) {
  const client     = newGrpcClient();
  const privateKey = crypto.createPrivateKey(voterKeyPem);

  const gateway = connect({
    client,
    identity: { mspId, credentials: voterCertPem },
    signer:   signers.newPrivateKeySigner(privateKey),
    evaluateOptions:     () => ({ deadline: Date.now() + 5_000 }),
    endorseOptions:      () => ({ deadline: Date.now() + 15_000 }),
    submitOptions:       () => ({ deadline: Date.now() + 5_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
  });

  const network  = gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);

  return { gateway, contract };
}

async function connectGatewayForOrg(mspId) {
  const profile = ORG_PROFILES[mspId];
  if (!profile) throw new Error(`지원하지 않는 MSP입니다: ${mspId}`);

  const orgDir = path.join(NETWORK_DIR, `crypto-config/peerOrganizations/${profile.domain}`);
  const tlsCaCert = path.join(orgDir, `peers/${profile.peer}/tls/ca.crt`);
  const userMspDir = path.join(orgDir, `users/${profile.user}/msp`);
  const signCert = path.join(userMspDir, `signcerts/${profile.user}-cert.pem`);
  const keystore = path.join(userMspDir, 'keystore');

  const client     = newGrpcClient(tlsCaCert, profile.endpoint, profile.peer);
  const certPem    = fs.readFileSync(signCert);
  const keyPem     = readPrivateKey(keystore);
  const privateKey = crypto.createPrivateKey(keyPem);

  const gateway = connect({
    client,
    identity: { mspId, credentials: certPem },
    signer:   signers.newPrivateKeySigner(privateKey),
    evaluateOptions:     () => ({ deadline: Date.now() + 5_000 }),
    endorseOptions:      () => ({ deadline: Date.now() + 15_000 }),
    submitOptions:       () => ({ deadline: Date.now() + 5_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
  });

  const network  = gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);
  return { gateway, contract };
}

async function connectGatewayForShareIndex(shareIndex) {
  const mspId = SHARE_INDEX_MSP[String(shareIndex)];
  if (!mspId) throw new Error(`shareIndex는 1, 2, 3 중 하나여야 합니다: ${shareIndex}`);
  return connectGatewayForOrg(mspId);
}

module.exports = { connectGateway, connectGatewayAsVoter, connectGatewayForOrg, connectGatewayForShareIndex };
