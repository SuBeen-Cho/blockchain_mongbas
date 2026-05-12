'use strict';

const bbs = require('../src/lib/bbs-idemix');

if (!process.env.BBS_ISSUER_SEED) {
  console.error('BBS_ISSUER_SEED 환경변수가 필요합니다. API 서버와 체인코드 배포에 같은 seed를 사용하세요.');
  process.exit(1);
}

bbs.exportPublicKeyB64()
  .then((pub) => console.log(pub))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
