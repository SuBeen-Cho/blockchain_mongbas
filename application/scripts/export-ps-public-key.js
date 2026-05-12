'use strict';

const ps = require('../src/lib/ps-idemix');

if (!process.env.PS_ISSUER_SEED) {
  console.error('PS_ISSUER_SEED 환경변수가 필요합니다. API 서버와 체인코드 배포에 같은 seed를 사용하세요.');
  process.exit(1);
}

console.log(ps.exportPublicKeyB64());
