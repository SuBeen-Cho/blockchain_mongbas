/**
 * lib/asym-keys.js — Ed25519 키쌍 싱글톤
 *
 * credential.js (발급)와 auth.js (검증) 모두 동일한 키쌍을 사용해야 하므로
 * 별도 모듈로 분리해 Node.js require 캐시를 통해 싱글톤 보장.
 *
 * 운영 환경에서는 generateKeyPair() 대신 파일/HSM에서 로드하도록 교체할 것.
 */

'use strict';

const crypto = require('crypto');

let _privateKey = null;
let _publicKey  = null;

/**
 * @returns {{ privateKey: Buffer, publicKey: Buffer }} DER 형식 키쌍
 */
function getEd25519Keys() {
  if (!_privateKey) {
    if (process.env.ED25519_PRIVATE_KEY_DER_B64 && process.env.ED25519_PUBLIC_KEY_DER_B64) {
      _privateKey = Buffer.from(process.env.ED25519_PRIVATE_KEY_DER_B64, 'base64');
      _publicKey  = Buffer.from(process.env.ED25519_PUBLIC_KEY_DER_B64,  'base64');
      console.log('[asym-keys] Ed25519 키쌍 로드 (환경변수)');
    } else {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
        publicKeyEncoding:  { type: 'spki',  format: 'der' },
      });
      _privateKey = privateKey;
      _publicKey  = publicKey;
      console.warn('[asym-keys] Ed25519 키쌍 생성 (개발용, 서버 재시작 시 갱신). 운영/체인코드 검증에는 ED25519_*_DER_B64 환경변수를 사용하세요.');
    }
  }
  return { privateKey: _privateKey, publicKey: _publicKey };
}

module.exports = { getEd25519Keys };
